/**
 * week-diff-sum.js - 可转债周间跳空差值计算
 *
 * 计算规则: sum(周一开盘价 - 上周五收盘价)
 * 数据源: akshare → bond_zh_hs_cov_daily
 *
 * 用法:
 *   node week-diff-sum.js --name 声迅转债 --from 20260101 --to 20260703
 *   node week-diff-sum.js --name 127080 --from 2026
 *   node week-diff-sum.js --name 超达转债 --from 20260101 --to 20260703 -d
 */

const { spawn } = require("child_process");
const path = require("path");

const PY_SCRIPT = path.join(__dirname, "cb_week_diff_sum.py");
const PYTHON = "python";

/**
 * 计算周间跳空差值
 * @param {Object} opts - { code, from, to }
 */
function calcWeekDiffSum(opts = {}) {
  return new Promise((resolve, reject) => {
    if (opts.name && !opts.code) {
      findCode(opts.name)
        .then((code) => {
          opts.code = code;
          runCalc(opts).then(resolve).catch(reject);
        })
        .catch(reject);
    } else {
      runCalc(opts).then(resolve).catch(reject);
    }
  });
}

function runCalc(opts) {
  return new Promise((resolve, reject) => {
    const args = [PY_SCRIPT, "--code", opts.code];
    if (opts.from) args.push("--from", opts.from);
    if (opts.to) args.push("--to", opts.to);

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
        resolve(JSON.parse(stdout));
      } catch (e) {
        reject(new Error(`JSON 解析失败: ${e.message}`));
      }
    });

    proc.on("error", (err) => reject(new Error(`无法启动 Python: ${err.message}`)));
  });
}

/**
 * 通过名称查代码
 */
function findCode(name) {
  return new Promise((resolve, reject) => {
    const pyCode = `
import akshare as ak
spot = ak.bond_zh_hs_cov_spot()
spot = spot[~spot["symbol"].str.startswith("bj")]
matches = spot[spot["name"].str.contains("${name}", na=False)]
if len(matches) > 0:
    sym = str(matches.iloc[0]["symbol"])
    code = sym[2:] if len(sym) > 2 else sym
    print(code)
else:
    print("NOT_FOUND")
`;

    const proc = spawn(PYTHON, ["-c", pyCode], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    });

    let stdout = "";
    proc.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on("data", (chunk) => { process.stderr.write(chunk); });

    proc.on("close", (code) => {
      const result = stdout.trim();
      if (result === "NOT_FOUND" || code !== 0) {
        reject(new Error(`未找到: ${name}`));
      } else {
        resolve(result);
      }
    });
  });
}

/**
 * 格式化输出
 */
function printResult(result, showDetails) {
  const sep = "=".repeat(72);

  console.log(`\n${sep}`);
  console.log(`  ${result.code} 周间跳空差值 (周一开盘 - 上周五收盘)`);
  console.log(
    `  区间: ${result.from_date} ~ ${result.to_date} | 交易日: ${result.total_trading_days}`
  );
  console.log(
    `  周一组数: ${result.monday_count} | 有效配对: ${result.valid_pairs} | 跳过: ${result.skipped}`
  );
  console.log(sep);
  console.log(
    `  正差值: ${result.positive_count} | 负差值: ${result.negative_count} | 零: ${result.zero_count}`
  );
  console.log(
    `  最大正差: ${result.max_positive.diff} (${result.max_positive.friday} → ${result.max_positive.monday})`
  );
  console.log(
    `  最大负差: ${result.max_negative.diff} (${result.max_negative.friday} → ${result.max_negative.monday})`
  );
  console.log(`  差值总和: ${result.total > 0 ? "+" : ""}${result.total.toFixed(3)}`);
  console.log(sep);

  if (showDetails && result.details && result.details.length > 0) {
    console.log(
      `\n  ${"上周五".padEnd(12)} ${"周一".padEnd(12)} ${"周五收".padStart(10)} ${"周一开".padStart(10)} ${"差值".padStart(10)}  ${"标记"}`
    );
    console.log("  " + "-".repeat(66));

    result.details.forEach((d) => {
      let mark = "";
      if (d.diff === result.max_positive.diff) mark = "★ 最大正";
      else if (d.diff === result.max_negative.diff) mark = "▼ 最大负";

      console.log(
        `  ${d.friday_date.padEnd(12)} ${d.monday_date.padEnd(12)} ${d.friday_close.toFixed(3).padStart(10)} ${d.monday_open.toFixed(3).padStart(10)} ${d.diff > 0 ? "+" : ""}${d.diff.toFixed(3).padStart(9)}  ${mark}`
      );
    });

    console.log(`\n${sep}\n`);
  }
}

// ============ 主流程 ============
async function main() {
  const args = process.argv.slice(2);
  const opts = { name: "", code: "", from: "", to: "" };
  let showDetails = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--name" && args[i + 1]) {
      opts.name = args[i + 1];
      if (/^\d+$/.test(opts.name)) {
        opts.code = opts.name;
      }
      i++;
    } else if (args[i] === "--from" && args[i + 1]) {
      opts.from = args[i + 1];
      i++;
    } else if (args[i] === "--to" && args[i + 1]) {
      opts.to = args[i + 1];
      i++;
    } else if (args[i] === "--detail" || args[i] === "-d") {
      showDetails = true;
    }
  }

  // 快捷年份模式
  if (opts.from && opts.from.length === 4 && /^\d{4}$/.test(opts.from)) {
    opts.to = opts.to || `${opts.from}1231`;
    opts.from = `${opts.from}0101`;
  }

  if (!opts.code && !opts.name) {
    console.log("用法: node week-diff-sum.js --name <转债名称或代码> --from <YYYYMMDD> --to <YYYYMMDD> [-d]");
    console.log("示例:");
    console.log("  node week-diff-sum.js --name 声迅转债 --from 20260101 --to 20260703");
    console.log("  node week-diff-sum.js --name 127080 --from 2026");
    console.log("  node week-diff-sum.js --name 超达转债 --from 20260101 --to 20260703 -d");
    console.log("\n计算规则: 周一开盘价 - 上周五收盘价");
    process.exit(1);
  }

  if (!opts.to) {
    const now = new Date();
    opts.to = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
  }

  console.log(`\n可转债周间跳空差值计算`);
  const idStr = opts.code || opts.name;
  console.log(`参数: code/name=${idStr}, from=${opts.from}, to=${opts.to}\n`);
  console.log("规则: 周一开盘 - 上周五收盘\n");

  try {
    const startTime = Date.now();
    const result = await calcWeekDiffSum(opts);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    if (result.error) {
      console.error(`错误: ${result.error}`);
      process.exit(1);
    }

    printResult(result, showDetails);
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

// node week-diff-sum.js --name 127080 --from 20260101 --to 20260703
// node week-diff-sum.js --name 声迅转债 --from 2026 -d
// node week-diff-sum.js --name 超达转债 --from 20260101 --to 20260703