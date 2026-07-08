/**
 * diff-ten-min-sum.js - 可转债分时差值计算（动态时间段）
 *
 * 计算规则: 每天 time_end价格 - time_start价格，输出差值总和
 * 数据源: akshare stock_zh_a_hist_min_em (5分钟K线)
 *   time_start ≈ 对应5分钟K线的开盘价
 *   time_end   ≈ 对应5分钟K线的收盘价
 *
 * 用法:
 *   node diff-ten-min-sum.js --name 声迅转债 --from 20260701 --to 20260703
 *   node diff-ten-min-sum.js --name 127080 --from 20260701 --to 20260703 --times 10:30-13:10
 *   node diff-ten-min-sum.js --name 超达转债 --from 2026 --times 09:35-09:45
 */

const { spawn } = require("child_process");
const path = require("path");

const PY_SCRIPT = path.join(__dirname, "cb_minutes-diff-sum.py");
const PYTHON = "python";

/**
 * 解析时间参数 "HH:MM-HH:MM" => { start: "HH:MM", end: "HH:MM" }
 */
function parseTimes(timesStr) {
  const match = timesStr.match(/^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/);
  if (!match) {
    throw new Error(`时间格式错误: "${timesStr}"，应为 "HH:MM-HH:MM"，如 "09:30-09:40"`);
  }
  const start = match[1].split(":").map(Number);
  const end = match[2].split(":").map(Number);
  const fmt = (h, m) => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  return {
    timeStart: fmt(start[0], start[1]),
    timeEnd: fmt(end[0], end[1]),
  };
}

/**
 * 计算分时差值（支持多股票）
 * @param {Object} opts - { names, codes, from, to, timeStart, timeEnd }
 * @returns {Promise<Array<Object>>} 始终返回数组
 */
function calcTenMinSum(opts = {}) {
  return new Promise((resolve, reject) => {
    const allCodes = (opts.codes || []).slice();
    const allNames = (opts.names || []).slice();

    if (allNames.length > 0) {
      resolveCodes(allNames)
        .then((resolved) => {
          // 合并：name查到的code + 直接传入的codes
          const codeToName = {};
          resolved.forEach((r) => {
            allCodes.push(r.code);
            codeToName[r.code] = r.name;
          });
          runCalc(allCodes, opts, codeToName).then(resolve).catch(reject);
        })
        .catch(reject);
    } else {
      runCalc(allCodes, opts, {}).then(resolve).catch(reject);
    }
  });
}

function runCalc(codes, opts, codeToName) {
  return new Promise((resolve, reject) => {
    if (codes.length === 0) {
      reject(new Error("没有有效的转债代码"));
      return;
    }

    const args = [
      PY_SCRIPT,
      "--codes", codes.join(","),
      "--from", opts.from,
      "--to", opts.to,
      "--time-start", opts.timeStart || "09:30",
      "--time-end", opts.timeEnd || "09:40",
    ];

    const proc = spawn(PYTHON, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    });

    const TIMEOUT_MS = Math.max(codes.length * 30000, 90000);
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        process.stderr.write(`\n  ⚠ 超时 (${TIMEOUT_MS / 1000}s)，强制终止...\n`);
        proc.kill("SIGKILL");
        reject(new Error(`计算超时 (${TIMEOUT_MS / 1000}s)`));
      }
    }, TIMEOUT_MS);

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      process.stderr.write(chunk);
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code !== 0) {
        reject(new Error(`Python exit ${code}: ${stderr}`));
        return;
      }
      try {
        const results = JSON.parse(stdout);
        // 注入name到每个结果
        const items = Array.isArray(results) ? results : [results];
        items.forEach((r) => {
          if (codeToName[r.code]) r.name = codeToName[r.code];
        });
        resolve(items);
      } catch (e) {
        reject(new Error(`JSON parse: ${e.message}`));
      }
    });

    proc.on("error", (err) => reject(new Error(`spawn: ${err.message}`)));
  });
}

/**
 * 批量通过名称查代码（单次Python调用，返回 {code, name} 数组）
 */
function resolveCodes(names) {
  return new Promise((resolve, reject) => {
    const namesJson = JSON.stringify(names);
    const pyCode = `
import akshare as ak
import json
spot = ak.bond_zh_hs_cov_spot()
spot = spot[~spot["symbol"].str.startswith("bj")]
result = []
for name in ${namesJson}:
    matches = spot[spot["name"].str.contains(name, na=False)]
    if len(matches) > 0:
        sym = str(matches.iloc[0]["symbol"])
        code = sym[2:] if len(sym) > 2 else sym
        result.append({"code": code, "name": name})
print(json.dumps(result, ensure_ascii=False))
`;

    const proc = spawn(PYTHON, ["-c", pyCode], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    });

    let stdout = "";
    proc.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on("data", (chunk) => { process.stderr.write(chunk); });

    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`批量查代码失败`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (e) {
        reject(new Error(`查代码JSON解析失败: ${e.message}`));
      }
    });
  });
}

/**
 * 计算字符串视觉宽度（中文/全角=2，英文/半角=1）
 */
function vw(s) {
  let w = 0;
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    w += (c > 0x7f || c === 0xff0c) ? 2 : 1;
  }
  return w;
}

/** 视觉宽度左填充 */
function vpl(s, w) { const n = w - vw(s); return n > 0 ? s + " ".repeat(n) : s; }

/** 视觉宽度右填充 */
function vpr(s, w) { const n = w - vw(s); return n > 0 ? " ".repeat(n) + s : s; }

/**
 * 格式化输出（支持单股/多股）
 */
function printResult(results, showDetails, mode) {
  const showPrice = mode === "price" || mode === "both";
  const showPct = mode === "pct" || mode === "both";
  const items = Array.isArray(results) ? results : [results];
  const validItems = items.filter((r) => !r.error);
  const multiStock = validItems.length > 1;

  if (validItems.length === 0) {
    console.log("\n无有效数据");
    return;
  }

  const timeLabel = `${validItems[0].time_start} → ${validItems[0].time_end}`;

  if (multiStock) {
    // ============ 多股对比表 ============
    const sep = "=".repeat(78);
    console.log(`\n${sep}`);
    console.log(`  多股分时差值对比 (${timeLabel})`);
    console.log(
      `  区间: ${validItems[0].from_date} ~ ${validItems[0].to_date} | 共 ${validItems.length} 只`
    );
    console.log(sep);

    // 按红率降序排列
    validItems.sort((a, b) => {
      const zcA = a.zero_count != null ? a.zero_count : 0;
      const zcB = b.zero_count != null ? b.zero_count : 0;
      const totalA = a.positive_count + a.negative_count + zcA;
      const totalB = b.positive_count + b.negative_count + zcB;
      const rateA = totalA > 0 ? a.positive_count / totalA : 0;
      const rateB = totalB > 0 ? b.positive_count / totalB : 0;
      return rateB - rateA;
    });

    // 构建表格数据行
    const rows = validItems.map((r) => {
      const zc = r.zero_count != null ? r.zero_count : 0;
      const bullTotal = r.positive_count + r.negative_count + zc;
      const bullRate = bullTotal > 0 ? (r.positive_count / bullTotal * 100).toFixed(1) : "0.0";
      const totalStr = r.total > 0 ? "+" + r.total.toFixed(2) : r.total.toFixed(2);
      const pctStr = r.pct_total > 0 ? "+" + r.pct_total.toFixed(2) : r.pct_total.toFixed(2);
      return {
        code: r.code,
        name: (r.name || r.code).slice(0, 10),
        days: String(r.total_trading_days),
        valid: String(r.valid_days),
        total: totalStr,
        pnz: r.positive_count + "/" + r.negative_count + "/" + zc,
        bullRate: bullRate + "%",
        pctTotal: pctStr + "%",
      };
    });

    // 计算每列最大视觉宽度
    const headers = ["代码", "名称", "交易日", "有效"];
    const keys = ["code", "name", "days", "valid"];
    // 全部右对齐：标题与数据列在同一基准线对齐
    const aligns = ["right", "right", "right", "right"];
    if (showPrice) { headers.push("价差和"); keys.push("total"); aligns.push("right"); }
    headers.push("涨/跌/平"); keys.push("pnz"); aligns.push("right");
    headers.push("红率"); keys.push("bullRate"); aligns.push("right");
    if (showPct) { headers.push("%和"); keys.push("pctTotal"); aligns.push("right"); }

    const colWidths = headers.map((h, i) => {
      let mw = vw(h);
      rows.forEach((row) => { const w = vw(String(row[keys[i]])); if (w > mw) mw = w; });
      return mw + 2;
    });

    // 输出标题行（右对齐，与数据列保持一致）
    let headerLine = "  ";
    headers.forEach((h, i) => headerLine += vpr(h, colWidths[i]));
    console.log(headerLine);

    // 输出分隔线
    const totalWidth = colWidths.reduce((a, b) => a + b, 0);
    console.log("  " + "-".repeat(totalWidth));

    // 输出数据行
    rows.forEach((row) => {
      let line = "  ";
      keys.forEach((k, i) => {
        const val = String(row[k]);
        line += (aligns[i] === "right") ? vpr(val, colWidths[i]) : vpl(val, colWidths[i]);
      });
      console.log(line);
    });

    console.log(sep);

    // 单品明细
    if (showDetails) {
      validItems.forEach((r) => {
        printSingleDetail(r, showPrice, showPct);
      });
    }
  } else {
    // ============ 单股详情 ============
    const r = validItems[0];
    console.log(`\n${sep}`);
    console.log(`  ${r.code}${r.name ? " " + r.name : ""} 分时差值 (${timeLabel})`);
    console.log(
      `  区间: ${r.from_date} ~ ${r.to_date} | 交易日: ${r.total_trading_days} | 有效: ${r.valid_days}`
    );
    console.log(sep);

    if (showPrice) {
      const zc = r.zero_count != null ? r.zero_count : 0;
      const bullTotal = r.positive_count + r.negative_count + zc;
      const bullRate = bullTotal > 0 ? (r.positive_count / bullTotal * 100).toFixed(1) : "0.0";
      console.log(
        `  [价格差值] 正: ${r.positive_count} | 负: ${r.negative_count} | 零: ${zc} | 红率: ${bullRate}%`
      );
      console.log(`  最大正: ${r.max_positive.diff} (${r.max_positive.date})`);
      console.log(`  最大负: ${r.max_negative.diff} (${r.max_negative.date})`);
      console.log(`  差值总和: ${r.total > 0 ? "+" : ""}${r.total.toFixed(3)}`);
    }

    if (showPct) {
      console.log(
        `  [百分比差值] 正: ${r.pct_positive_count} | 负: ${r.pct_negative_count} | 零: ${r.pct_zero_count}`
      );
      if (r.max_pct_positive) {
        console.log(
          `  最大正%: ${r.max_pct_positive.pct_diff > 0 ? "+" : ""}${r.max_pct_positive.pct_diff}% (${r.max_pct_positive.date})`
        );
      }
      if (r.max_pct_negative) {
        console.log(
          `  最大负%: ${r.max_pct_negative.pct_diff > 0 ? "+" : ""}${r.max_pct_negative.pct_diff}% (${r.max_pct_negative.date})`
        );
      }
      console.log(
        `  百分比差值总和: ${r.pct_total > 0 ? "+" : ""}${r.pct_total.toFixed(3)}%`
      );
    }

    if (r.empty_days > 0 || r.no_bar_days > 0) {
      console.log(
        `  ⚠ 无分钟数据: ${r.empty_days} 天 | 缺少目标bar: ${r.no_bar_days} 天`
      );
    }
    console.log("  注: 分钟数据覆盖约近1个月，更早日期可能无数据");
    console.log(sep);

    if (showDetails) {
      printSingleDetail(r, showPrice, showPct);
    }
  }

  // 错误股票
  const errItems = items.filter((r) => r.error);
  if (errItems.length > 0) {
    console.log(`\n  跳过: ${errItems.map((e) => e.code).join(", ")}（无有效数据）`);
  }
}

/**
 * 输出单个转债的明细表
 */
function printSingleDetail(r, showPrice, showPct) {
  if (!r.details || r.details.length === 0) return;

  const label = r.name ? `${r.code} ${r.name}` : r.code;
  console.log(`\n  ── ${label} ──`);

  const ts = r.time_start.padStart(5);
  const te = r.time_end.padStart(5);

  let header = `  ${"日期".padEnd(12)} ${ts.padStart(10)} ${te.padStart(10)} `;
  if (showPrice) header += `${"差值".padStart(10)}`;
  if (showPct) header += ` ${"涨跌%".padStart(9)}`;
  console.log(header);
  console.log("  " + "-".repeat(48));

  r.details.forEach((d) => {
    let line = `  ${d.date.padEnd(12)} ${d.price_start.toFixed(3).padStart(10)} ${d.price_end.toFixed(3).padStart(10)} `;
    let marks = [];

    if (showPrice) {
      const diffStr = d.diff > 0 ? "+" + d.diff.toFixed(3) : d.diff.toFixed(3);
      line += `${diffStr.padStart(10)}`;
      if (r.max_positive && d.diff === r.max_positive.diff) marks.push("价格最大正");
      if (r.max_negative && d.diff === r.max_negative.diff) marks.push("价格最大负");
    }
    if (showPct) {
      const pd = d.pct_diff > 0 ? "+" + d.pct_diff.toFixed(2) : d.pct_diff.toFixed(2);
      line += ` ${pd.padStart(9)}%`;
      if (r.max_pct_positive && d.pct_diff === r.max_pct_positive.pct_diff) marks.push("%最大正");
      if (r.max_pct_negative && d.pct_diff === r.max_pct_negative.pct_diff) marks.push("%最大负");
    }
    if (marks.length > 0) line += `  ◆ ${marks.join(", ")}`;

    console.log(line);
  });
}

// ============ 主流程 ============
async function main() {
  const args = process.argv.slice(2);
  const opts = { names: [], codes: [], from: "", to: "", timeStart: "09:30", timeEnd: "09:40" };
  let showDetails = false;
  let mode = "both";  // price | pct | both

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--name" && args[i + 1]) {
      const val = args[i + 1];
      if (/^\d+$/.test(val)) {
        opts.codes.push(val);
      } else {
        opts.names.push(val);
      }
      i++;
    } else if (args[i] === "--names" && args[i + 1]) {
      args[i + 1].split(",").forEach((s) => {
        const val = s.trim();
        if (!val) return;
        if (/^\d+$/.test(val)) {
          opts.codes.push(val);
        } else {
          opts.names.push(val);
        }
      });
      i++;
    } else if (args[i] === "--code" && args[i + 1]) {
      opts.codes.push(args[i + 1]);
      i++;
    } else if (args[i] === "--codes" && args[i + 1]) {
      args[i + 1].split(",").forEach((s) => {
        const val = s.trim();
        if (val) opts.codes.push(val);
      });
      i++;
    } else if (args[i] === "--from" && args[i + 1]) {
      opts.from = args[i + 1];
      i++;
    } else if (args[i] === "--to" && args[i + 1]) {
      opts.to = args[i + 1];
      i++;
    } else if (args[i] === "--times" && args[i + 1]) {
      try {
        const parsed = parseTimes(args[i + 1]);
        opts.timeStart = parsed.timeStart;
        opts.timeEnd = parsed.timeEnd;
      } catch (e) {
        console.error(`错误: ${e.message}`);
        process.exit(1);
      }
      i++;
    } else if (args[i] === "--detail" || args[i] === "-d") {
      showDetails = true;
    } else if (args[i] === "--mode" && args[i + 1]) {
      const m = args[i + 1].toLowerCase();
      if (["price", "pct", "both"].includes(m)) {
        mode = m;
      } else {
        console.error(`错误: --mode 参数必须为 price/pct/both，当前: "${args[i + 1]}"`);
        process.exit(1);
      }
      i++;
    }
  }

  // 去重
  opts.names = [...new Set(opts.names)];
  opts.codes = [...new Set(opts.codes)];

  // 快捷年份模式
  if (opts.from && opts.from.length === 4 && /^\d{4}$/.test(opts.from)) {
    opts.to = opts.to || `${opts.from}1231`;
    opts.from = `${opts.from}0101`;
  }

  const totalStocks = opts.names.length + opts.codes.length;
  if (totalStocks === 0) {
    console.log("用法: node minutes-diff-sum.js --name <转债名称或代码> --from <YYYYMMDD> --to <YYYYMMDD> [选项]");
    console.log("选项:");
    console.log("  --name <名称|代码>       指定单个转债（可多次使用）");
    console.log("  --names <名1,名2,...>    逗号分隔多个转债（可混用代码/名称）");
    console.log("  --code <代码>            直接指定代码");
    console.log("  --codes <代码1,代码2>    逗号分隔多个代码");
    console.log("  --times HH:MM-HH:MM      时间段 (默认 09:30-09:40)");
    console.log("  --mode price|pct|both    输出模式 (默认 both)");
    console.log("  -d, --detail             显示每日明细");
    console.log("示例:");
    console.log("  node minutes-diff-sum.js --name 声迅转债 --from 2026 --mode pct -d");
    console.log("  node minutes-diff-sum.js --names 声迅转债,超达转债 --from 2026 --mode pct -d");
    console.log("  node minutes-diff-sum.js --codes 127080,123231 --from 20260101 --to 20260706");
    console.log("  node minutes-diff-sum.js --name 声迅转债 --name 超达转债 --from 2026");
    console.log("\n默认时段: 09:30-09:40");
    process.exit(1);
  }

  if (!opts.to) {
    const now = new Date();
    opts.to = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
  }

  console.log(`\n可转债分时差值计算`);
  const labelParts = [];
  if (opts.names.length > 0) labelParts.push(opts.names.join(", "));
  if (opts.codes.length > 0) labelParts.push(opts.codes.join(", "));
  console.log(`目标: ${labelParts.join(" | ")}`);
  console.log(`参数: from=${opts.from}, to=${opts.to}, times=${opts.timeStart}-${opts.timeEnd}, mode=${mode}`);
  console.log(`提示: ${opts.timeStart}用对应K线开盘价, ${opts.timeEnd}用对应K线收盘价\n`);

  try {
    const startTime = Date.now();
    const results = await calcTenMinSum(opts);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    printResult(results, showDetails, mode);
    console.log(`耗时: ${elapsed}s`);
  } catch (err) {
    console.error(`\n错误: ${err.message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { calcTenMinSum };


// node minutes-diff-sum.js --names 声迅转债,蓝晓转02,大中转债 --from 20260120 --to 20260703 --times "9:30-9:40" -d
// node minutes-diff-sum.js --names 声迅转债,蓝晓转02,大中转债,惠城转债,福新转债,超达转债,联瑞转债,泰坦转债 --from 2026 --times "11:00-13:05" -d


// node minutes-diff-sum.js --names 声迅转债,蓝晓转02,大中转债,惠城转债,福新转债,超达转债,联瑞转债,泰坦转债 --from 2026 --times "9:30-9:40" -d

// # 全量扫描，默认时段 09:30-09:40
// node minutes-diff-sum-all.js --from 2026

// # 红率 TOP 30
// node minutes-diff-sum-all.js --from 2026 --limit 30

// # 自定义时段
// node minutes-diff-sum-all.js --from 20260501 --to 20260708 --times "9:30-9:40" --limit 30
