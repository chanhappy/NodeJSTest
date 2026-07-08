/**
 * days-diff-sum-ex-all.js - 全量可转债隔夜跳空差值计算工具（次日9:40版）
 *
 * 自动获取全部可转债代码，批量计算并输出结果。
 * 与 days-diff-sum-ex.js 的区别：无需手动指定名称/代码，自动全量处理。
 *
 * 用法:
 *   node days-diff-sum-ex-all.js --from 2026
 *   node days-diff-sum-ex-all.js --from 20260101 --to 20260708
 *   node days-diff-sum-ex-all.js --from 2026 --limit 50 --mode both
 */

const { spawn } = require("child_process");
const path = require("path");

const PY_SCRIPT = path.join(__dirname, "cb_days-diff-sum-ex.py");
const PYTHON = "python";
const BATCH_SIZE = 20; // 每批处理的债券数量

// ======================================================================
//  获取全部可转债代码与名称（排除北交所）
// ======================================================================
function getAllCodes() {
  return new Promise((resolve, reject) => {
    const pyCode = `
import akshare as ak
import json
spot = ak.bond_zh_hs_cov_spot()
spot = spot[~spot["symbol"].str.startswith("bj")]
result = []
for _, row in spot.iterrows():
    sym = str(row["symbol"])
    code = sym[2:] if len(sym) > 2 else sym
    name = str(row["name"]) if "name" in row else code
    result.append({"code": code, "name": name})
print(json.dumps(result, ensure_ascii=False))
`;
    const proc = spawn(PYTHON, ["-c", pyCode], {
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
        reject(new Error(`获取全量代码失败: ${stderr}`));
        return;
      }
      try {
        const codes = JSON.parse(stdout);
        resolve(codes);
      } catch (e) {
        reject(new Error(`代码JSON解析失败: ${e.message}`));
      }
    });

    proc.on("error", (err) => reject(new Error(`spawn: ${err.message}`)));
  });
}

// ======================================================================
//  调用 Python 脚本批量计算
// ======================================================================
function runCalc(codes, opts, codeToName) {
  return new Promise((resolve, reject) => {
    if (codes.length === 0) {
      reject(new Error("没有有效的转债代码"));
      return;
    }

    const args = [
      PY_SCRIPT,
      "--names", codes.join(","),
      "--from", opts.from,
      "--to", opts.to,
    ];

    const TIMEOUT_MS = Math.max(codes.length * 30000, 90000);
    let settled = false;

    const proc = spawn(PYTHON, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    });

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
        reject(new Error(`Python exit ${code}: ${stderr.slice(-200)}`));
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
        reject(new Error(`JSON parse: ${e.message}`));
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      reject(new Error(`spawn: ${err.message}`));
    });
  });
}

// ======================================================================
//  分批批量计算（支持进度显示）
// ======================================================================
async function runCalcBatch(allCodes, opts) {
  const batches = [];
  for (let i = 0; i < allCodes.length; i += BATCH_SIZE) {
    batches.push(allCodes.slice(i, i + BATCH_SIZE));
  }

  const codeToName = {};
  allCodes.forEach((c) => { codeToName[c.code] = c.name; });

  let allResults = [];
  let totalBatches = batches.length;

  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi];
    const batchCodes = batch.map((c) => c.code);

    process.stderr.write(
      `\n[批次 ${bi + 1}/${totalBatches}] 处理 ${batchCodes.length} 只 (${batch[0].name} ~ ${batch[batch.length - 1].name})...\n`
    );

    try {
      const results = await runCalc(batchCodes, opts, codeToName);
      allResults = allResults.concat(results);
      const valid = results.filter((r) => !r.error).length;
      process.stderr.write(`  ✓ 批次 ${bi + 1} 完成: ${results.length} 只, 有效 ${valid} 只 | 累计 ${allResults.length} 只\n`);
    } catch (e) {
      process.stderr.write(`批次 ${bi + 1} 失败: ${e.message}\n`);
      // 单只回退：每次处理一只
      for (const c of batch) {
        try {
          const r = await runCalc([c.code], opts, codeToName);
          allResults = allResults.concat(r);
        } catch (e2) {
          process.stderr.write(`  ${c.code} ${c.name} 失败: ${e2.message}\n`);
        }
      }
      process.stderr.write(`  ✓ 批次 ${bi + 1} 回退完成 | 累计 ${allResults.length} 只\n`);
    }

    // 批次间稍作暂停，避免触发限流
    if (bi < batches.length - 1) {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  return allResults;
}

// ======================================================================
//  视觉宽度对齐工具
// ======================================================================
function vw(s) {
  let w = 0;
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    w += (c > 0x7f || c === 0xff0c) ? 2 : 1;
  }
  return w;
}
function vpl(s, w) { const n = w - vw(s); return n > 0 ? s + " ".repeat(n) : s; }
function vpr(s, w) { const n = w - vw(s); return n > 0 ? " ".repeat(n) + s : s; }

// ======================================================================
//  格式化输出
// ======================================================================
function printResult(results, showDetails, mode, limit) {
  const showPrice = mode === "price" || mode === "both";
  const showPct = mode === "pct" || mode === "both";
  const items = Array.isArray(results) ? results : [results];
  const validItems = items.filter((r) => !r.error);

  if (validItems.length === 0) {
    console.log("\n无有效数据");
    return;
  }

  // 按红率降序排列
  validItems.sort((a, b) => {
    const pcA = a.zero_count != null ? a.zero_count : (a.pairs - a.positive_count - a.negative_count);
    const totalA = a.positive_count + a.negative_count + pcA;
    const rateA = totalA > 0 ? a.positive_count / totalA : 0;
    const pcB = b.zero_count != null ? b.zero_count : (b.pairs - b.positive_count - b.negative_count);
    const totalB = b.positive_count + b.negative_count + pcB;
    const rateB = totalB > 0 ? b.positive_count / totalB : 0;
    return rateB - rateA;
  });

  // 限制输出数量
  const displayItems = limit > 0 ? validItems.slice(0, limit) : validItems;

  // ============ 多股对比表 ============
  const sep = "=".repeat(78);
  console.log(`\n${sep}`);
  console.log(`  全量可转债隔夜跳空对比`);
  const limitInfo = limit > 0 ? `（红率 TOP ${limit}）` : "";
  console.log(
    `  区间: ${validItems[0].from_date} ~ ${validItems[0].to_date} | 有效: ${validItems.length} 只${limitInfo}`
  );
  console.log(sep);

  // 构建表格数据行
  const rows = displayItems.map((r) => {
    const pc = r.zero_count != null ? r.zero_count : (r.pairs - r.positive_count - r.negative_count);
    const bullTotal = r.positive_count + r.negative_count + pc;
    const bullRate = bullTotal > 0 ? (r.positive_count / bullTotal * 100).toFixed(1) : "0.0";
    const totalStr = r.total > 0 ? "+" + r.total.toFixed(2) : r.total.toFixed(2);
    const pctStr = r.pct_total > 0 ? "+" + r.pct_total.toFixed(2) : r.pct_total.toFixed(2);
    return {
      code: r.code,
      name: (r.name || r.code).slice(0, 10),
      days: String(r.trading_days),
      pairs: String(r.pairs),
      total: totalStr,
      pnz: r.positive_count + "/" + r.negative_count + "/" + pc,
      bullRate: bullRate + "%",
      pctTotal: pctStr + "%",
    };
  });

  // 计算每列最大视觉宽度
  const headers = ["代码", "名称", "交易日", "差价对"];
  const keys = ["code", "name", "days", "pairs"];
  const aligns = ["right", "right", "right", "right"];
  if (showPrice) { headers.push("价差和"); keys.push("total"); aligns.push("right"); }
  headers.push("涨/跌/平"); keys.push("pnz"); aligns.push("right");
  headers.push("红率"); keys.push("bullRate"); aligns.push("right");
  if (showPct) { headers.push("%和"); keys.push("pctTotal"); aligns.push("right"); }

  const colWidths = headers.map((h, i) => {
    const hw = vw(h);
    let mw = hw;
    rows.forEach((row) => {
      const w = vw(String(row[keys[i]]));
      if (w > mw) mw = w;
    });
    return mw + 2;
  });

  // 输出标题行
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
    displayItems.forEach((r) => {
      printSingleDetail(r, showPrice, showPct);
    });
  }

  // 错误统计
  const errItems = items.filter((r) => r.error);
  if (errItems.length > 0) {
    console.log(`\n  跳过: ${errItems.length} 只（无有效数据）`);
  }

  // 排名统计
  if (limit > 0 && validItems.length > limit) {
    console.log(`\n  注: 仅显示红率 TOP ${limit}，完整数据共 ${validItems.length} 只`);
  }
}

/**
 * 输出单个转债的明细表
 */
function printSingleDetail(r, showPrice, showPct) {
  if (!r.details || r.details.length === 0) return;

  const label = r.name ? `${r.code} ${r.name}` : r.code;
  console.log(`\n  ── ${label} ──`);

  let header = `\n  ${"日期".padEnd(12)} ${"→ 次日".padEnd(12)} ${"收盘".padStart(10)} ${"9:40价".padStart(10)} `;
  if (showPrice) header += `${"差值".padStart(10)}`;
  if (showPct) header += ` ${"涨跌%".padStart(9)}`;
  header += `  ${"标记"}`;
  console.log(header);
  console.log("  " + "-".repeat(68));

  r.details.forEach((d) => {
    if (d.next_0940 == null) return;

    let line = `  ${d.date.padEnd(12)} ${d.next_date.padEnd(12)} ${d.close.toFixed(3).padStart(10)} ${d.next_0940.toFixed(3).padStart(10)} `;
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

// ======================================================================
//  主流程
// ======================================================================
async function main() {
  const args = process.argv.slice(2);
  const opts = { from: "", to: "" };
  let showDetails = false;
  let mode = "both";
  let limit = 0; // 0 = 全部显示

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--from" && args[i + 1]) {
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
    } else if (args[i] === "--limit" && args[i + 1]) {
      limit = parseInt(args[i + 1], 10);
      if (isNaN(limit) || limit < 1) {
        console.error(`错误: --limit 必须为正整数`);
        process.exit(1);
      }
      i++;
    }
  }

  // 快捷年份模式
  if (opts.from && opts.from.length === 4 && /^\d{4}$/.test(opts.from)) {
    opts.to = opts.to || `${opts.from}1231`;
    opts.from = `${opts.from}0101`;
  }

  if (!opts.from) {
    console.log("用法: node days-diff-sum-ex-all.js --from <YYYYMMDD|YYYY> [选项]");
    console.log("选项:");
    console.log("  --from <日期|年份>   起始日期 (必填)");
    console.log("  --to <日期>          结束日期 (默认当年末)");
    console.log("  --limit <N>          仅显示红率 TOP N 的转债 (0=全部，默认0)");
    console.log("  --mode price|pct|both 输出模式 (默认 both)");
    console.log("  -d, --detail         显示每日明细（数据量巨大，慎用）");
    console.log("");
    console.log("计算规则: 次日9:40价格 - 当日收盘价");
    console.log("示例:");
    console.log("  node days-diff-sum-ex-all.js --from 2026");
    console.log("  node days-diff-sum-ex-all.js --from 2026 --limit 30");
    console.log("  node days-diff-sum-ex-all.js --from 20260101 --to 20260708 --limit 50");
    process.exit(1);
  }

  // 默认 to
  if (!opts.to) {
    const now = new Date();
    opts.to = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
  }

  console.log(`\n全量可转债隔夜跳空差值计算`);
  console.log(`参数: from=${opts.from}, to=${opts.to}, mode=${mode}, limit=${limit || "全部"}`);

  try {
    // 1. 获取全量代码
    console.log(`\n[1/2] 获取全部可转债列表...`);
    const allCodes = await getAllCodes();
    console.log(`  共获取 ${allCodes.length} 只可转债\n`);

    // 2. 批量计算
    const startTime = Date.now();
    const results = await runCalcBatch(allCodes, opts);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    // 3. 输出结果
    printResult(results, showDetails, mode, limit);
    console.log(`耗时: ${elapsed}s (共 ${allCodes.length} 只)`);
  } catch (err) {
    console.error(`\n错误: ${err.message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { getAllCodes, runCalcBatch };
