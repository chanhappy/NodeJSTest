/**
 * week-diff-sum.js - 可转债周间跳空差值计算
 *
 * 计算规则: sum(周一开盘价 - 上周五收盘价)
 * 数据源: akshare → bond_zh_hs_cov_daily
 *
 * 用法:
 *   node week-diff-sum.js --name 声迅转债 --from 20260101 --to 20260703
 *   node week-diff-sum.js --names 声迅转债,超达转债 --from 2026
 *   node week-diff-sum.js --code 127080 --from 2026
 */

const { spawn } = require("child_process");
const path = require("path");

const PY_SCRIPT = path.join(__dirname, "cb_week_diff_sum.py");
const PYTHON = "python";

/**
 * 计算周间跳空差值（支持多股票）
 * @param {Object} opts - { names, codes, from, to }
 * @returns {Promise<Array<Object>>} 始终返回数组
 */
function calcWeekDiffSum(opts = {}) {
  return new Promise((resolve, reject) => {
    const allCodes = (opts.codes || []).slice();
    const allNames = (opts.names || []).slice();

    if (allNames.length > 0) {
      resolveCodes(allNames)
        .then((resolved) => {
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

    const args = [PY_SCRIPT, "--names", codes.join(","), "--from", opts.from, "--to", opts.to];

    const proc = spawn(PYTHON, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      process.stderr.write(chunk);
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Python 退出码 ${code}: ${stderr}`));
        return;
      }
      try {
        const results = JSON.parse(stdout);
        const items = Array.isArray(results) ? results : [results];
        items.forEach((r) => {
          if (codeToName[r.code]) r.name = codeToName[r.code];
        });
        resolve(items);
      } catch (e) {
        reject(new Error(`JSON 解析失败: ${e.message}`));
      }
    });

    proc.on("error", (err) => {
      reject(new Error(`无法启动 Python: ${err.message}`));
    });
  });
}

/**
 * 批量通过名称查代码（单次Python调用）
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
 * 格式化输出（支持单股/多股）
 */
function printResult(results, showDetails, mode) {
  const showPrice = mode === "price" || mode === "both";
  const showPct = mode === "pct" || mode === "both";
  const sep = "=".repeat(78);
  const items = Array.isArray(results) ? results : [results];
  const validItems = items.filter((r) => !r.error);
  const multiStock = validItems.length > 1;

  if (validItems.length === 0) {
    console.log("\n无有效数据");
    return;
  }

  // 多股对比表
  if (multiStock) {
    console.log(`\n${sep}`);
    console.log(`  多股周间跳空对比（周一开盘 - 上周五收盘）`);
    console.log(
      `  区间: ${validItems[0].from_date} ~ ${validItems[0].to_date} | 共 ${validItems.length} 只`
    );
    console.log(sep);

    let header = `  ${"代码".padEnd(8)} ${"名称".padEnd(10)} ${"交易天".padStart(5)} ${"周一组".padStart(5)} `;
    if (showPrice) {
      header += `${"价差和".padStart(9)} `;
    }
    header += `${"涨/跌/平".padStart(10)}`;
    if (showPct) {
      header += ` ${"%和".padStart(9)}`;
    }
    console.log(header);
    console.log("  " + "-".repeat(65));

    validItems.forEach((r) => {
      let line = `  ${r.code.padEnd(8)} ${(r.name || r.code).padEnd(10)} ${String(r.total_trading_days).padStart(5)} ${String(r.monday_count).padStart(5)} `;
      if (showPrice) {
        const totalStr = r.total > 0 ? "+" + r.total.toFixed(2) : r.total.toFixed(2);
        line += `${totalStr.padStart(9)} `;
      }
      line += `${(r.positive_count + "/" + r.negative_count + "/" + r.zero_count).padStart(10)}`;
      if (showPct) {
        const pctStr = r.pct_total > 0 ? "+" + r.pct_total.toFixed(2) : r.pct_total.toFixed(2);
        line += ` ${pctStr.padStart(8)}%`;
      }
      console.log(line);
    });

    console.log(sep);

    if (showDetails) {
      validItems.forEach((r) => {
        printSingleDetail(r, showPrice, showPct);
      });
    }
  } else {
    // 单股详情
    const r = validItems[0];
    console.log(`\n${sep}`);
    console.log(`  ${r.name || r.code}（${r.code}）周间跳空差值（周一开盘 - 上周五收盘）`);
    console.log(
      `  区间: ${r.from_date} ~ ${r.to_date} | 交易日: ${r.total_trading_days}`
    );
    console.log(
      `  周一组数: ${r.monday_count} | 有效配对: ${r.valid_pairs} | 跳过: ${r.skipped}`
    );
    console.log(sep);

    if (showPrice) {
      console.log(
        `  [价格差值] 涨: ${r.positive_count} 天 | 跌: ${r.negative_count} 天 | 平: ${r.zero_count} 天`
      );
      console.log(`  最大正差: ${r.max_positive.diff}（${r.max_positive.friday} → ${r.max_positive.monday}）`);
      console.log(`  最大负差: ${r.max_negative.diff}（${r.max_negative.friday} → ${r.max_negative.monday}）`);
      console.log(`  价差和: ${r.total > 0 ? "+" : ""}${r.total.toFixed(3)}`);
    }

    if (showPct) {
      console.log(
        `  [百分比差值] 涨: ${r.pct_positive_count} 天 | 跌: ${r.pct_negative_count} 天 | 平: ${r.pct_zero_count} 天`
      );
      if (r.max_pct_positive) {
        console.log(`  最大正%: ${r.max_pct_positive.pct_diff > 0 ? "+" : ""}${r.max_pct_positive.pct_diff}%（${r.max_pct_positive.friday} → ${r.max_pct_positive.monday}）`);
      }
      if (r.max_pct_negative) {
        console.log(`  最大负%: ${r.max_pct_negative.pct_diff > 0 ? "+" : ""}${r.max_pct_negative.pct_diff}%（${r.max_pct_negative.friday} → ${r.max_pct_negative.monday}）`);
      }
      console.log(`  %和: ${r.pct_total > 0 ? "+" : ""}${r.pct_total.toFixed(3)}%`);
    }

    console.log(sep);

    if (showDetails && r.details && r.details.length > 0) {
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

  let header = `\n  ${"上周五".padEnd(12)} ${"周一".padEnd(12)} ${"周五收".padStart(10)} ${"周一开".padStart(10)} `;
  if (showPrice) header += `${"差值".padStart(10)}`;
  if (showPct) header += ` ${"涨跌%".padStart(9)}`;
  header += `  ${"标记"}`;
  console.log(header);
  console.log("  " + "-".repeat(68));

  r.details.forEach((d) => {
    let line = `  ${d.friday_date.padEnd(12)} ${d.monday_date.padEnd(12)} ${d.friday_close.toFixed(3).padStart(10)} ${d.monday_open.toFixed(3).padStart(10)} `;
    let marks = [];

    if (showPrice) {
      const diffStr = d.diff > 0 ? "+" + d.diff.toFixed(3) : d.diff.toFixed(3);
      line += `${diffStr.padStart(10)}`;
      if (d.diff === r.max_positive.diff) marks.push("价最大正");
      if (d.diff === r.max_negative.diff) marks.push("价最大负");
    }
    if (showPct) {
      const pd = d.pct_diff > 0 ? "+" + d.pct_diff.toFixed(2) : d.pct_diff.toFixed(2);
      line += ` ${pd.padStart(9)}%`;
      if (r.max_pct_positive && d.pct_diff === r.max_pct_positive.pct_diff) marks.push("%最大正");
      if (r.max_pct_negative && d.pct_diff === r.max_pct_negative.pct_diff) marks.push("%最大负");
    }
    if (marks.length > 0) line += `  ◆ ${marks.join(", ")}`;
    else line += `  `;

    console.log(line);
  });

  console.log("");
}

// ============ 主流程 ============
async function main() {
  const args = process.argv.slice(2);
  const opts = { names: [], codes: [], from: "", to: "" };
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
    console.log("用法: node week-diff-sum.js --name <转债名称或代码> --from <YYYYMMDD> --to <YYYYMMDD> [选项]");
    console.log("选项:");
    console.log("  --name <名称|代码>       指定单个转债（可多次使用）");
    console.log("  --names <名1,名2,...>    逗号分隔多个转债");
    console.log("  --code <代码>            直接指定代码");
    console.log("  --codes <代码1,代码2>    逗号分隔多个代码");
    console.log("  --mode price|pct|both    输出模式 (默认 both)");
    console.log("  -d, --detail             显示每周明细");
    console.log("计算规则: 周一开盘价 - 上周五收盘价");
    console.log("示例:");
    console.log("  node week-diff-sum.js --name 声迅转债 --from 20260101 --to 20260703");
    console.log("  node week-diff-sum.js --name 127080 --from 2026");
    console.log("  node week-diff-sum.js --name 超达转债 --from 2026 --mode pct -d");
    console.log("  node week-diff-sum.js --names 声迅转债,蓝晓转02,大中转债 --from 2026 -d");
    process.exit(1);
  }

  if (!opts.to) {
    const now = new Date();
    opts.to = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
  }

  const labelParts = [];
  if (opts.names.length > 0) labelParts.push(opts.names.join(", "));
  if (opts.codes.length > 0) labelParts.push(opts.codes.join(", "));
  console.log(`\n可转债周间跳空差值计算`);
  console.log(`目标: ${labelParts.join(" | ")}`);
  console.log(`参数: from=${opts.from}, to=${opts.to}, mode=${mode}`);
  console.log("规则: 周一开盘 - 上周五收盘\n");

  try {
    const startTime = Date.now();
    const results = await calcWeekDiffSum(opts);
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

module.exports = { calcWeekDiffSum };


// 对区间内每个周一，找最近的上周五：
//   差值 = 周一开盘价 - 上周五收盘价
//   总差异 = sum(所有差值)

// # 基本用法
// node week-diff-sum.js --name 127080 --from 20260101 --to 20260703
// node week-diff-sum.js --name 声迅转债 --from 2026 -d
//
// # 仅看百分比
// node week-diff-sum.js --name 声迅转债 --from 2026 --mode pct -d
//
// # 多股对比
// node week-diff-sum.js --names 声迅转债,蓝晓转02,大中转债,惠城转债,福新转债,超达转债,联瑞转债 --from 2026 -d