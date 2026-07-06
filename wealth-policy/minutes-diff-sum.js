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
 * 计算分时差值
 * @param {Object} opts - { code, from, to, timeStart, timeEnd }
 * @returns {Promise<Object>}
 */
function calcTenMinSum(opts = {}) {
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
    const args = [
      PY_SCRIPT,
      "--code", opts.code,
      "--from", opts.from,
      "--to", opts.to,
      "--time-start", opts.timeStart || "09:30",
      "--time-end", opts.timeEnd || "09:40",
    ];

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
        reject(new Error(`Python exit ${code}: ${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (e) {
        reject(new Error(`JSON parse: ${e.message}`));
      }
    });

    proc.on("error", (err) => reject(new Error(`spawn: ${err.message}`)));
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
  const sep = "=".repeat(64);
  const timeLabel = `${result.time_end} - ${result.time_start}`;

  console.log(`\n${sep}`);
  console.log(`  ${result.code} 分时差值 (${timeLabel})`);
  console.log(
    `  区间: ${result.from_date} ~ ${result.to_date} | 交易日: ${result.total_trading_days} | 有效: ${result.valid_days}`
  );
  console.log(sep);
  console.log(
    `  正差值: ${result.positive_count} | 负差值: ${result.negative_count} | 零: ${result.zero_count}`
  );
  if (result.empty_days > 0 || result.no_bar_days > 0) {
    console.log(
      `  ⚠ 无分钟数据: ${result.empty_days} 天 | 缺少目标bar: ${result.no_bar_days} 天`
    );
  }
  console.log(
    `  最大正: ${result.max_positive.diff} (${result.max_positive.date})`
  );
  console.log(
    `  最大负: ${result.max_negative.diff} (${result.max_negative.date})`
  );
  console.log(`  差值总和: ${result.total > 0 ? "+" : ""}${result.total.toFixed(3)}`);
  console.log("  注: 分钟数据覆盖约近1个月，更早日期可能无数据");
  console.log(sep);

  if (showDetails && result.details && result.details.length > 0) {
    const ts = result.time_start.padStart(5);
    const te = result.time_end.padStart(5);
    console.log(
      `\n  ${"日期".padEnd(12)} ${ts.padStart(10)} ${te.padStart(10)} ${"差值".padStart(10)}`
    );
    console.log("  " + "-".repeat(48));

    result.details.forEach((d) => {
      let mark = "";
      if (d.diff === result.max_positive.diff) mark = " ★ 最大正";
      else if (d.diff === result.max_negative.diff) mark = " ▼ 最大负";

      console.log(
        `  ${d.date.padEnd(12)} ${d.price_start.toFixed(3).padStart(10)} ${d.price_end.toFixed(3).padStart(10)} ${d.diff > 0 ? "+" : ""}${d.diff.toFixed(3).padStart(9)}${mark}`
      );
    });

    console.log(`\n${sep}\n`);
  }
}

// ============ 主流程 ============
async function main() {
  const args = process.argv.slice(2);
  const opts = { name: "", code: "", from: "", to: "", timeStart: "09:30", timeEnd: "09:40" };
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
    }
  }

  // 快捷年份模式
  if (opts.from && opts.from.length === 4 && /^\d{4}$/.test(opts.from)) {
    opts.to = opts.to || `${opts.from}1231`;
    opts.from = `${opts.from}0101`;
  }

  if (!opts.code && !opts.name) {
    console.log("用法: node diff-ten-min-sum.js --name <转债名称或代码> --from <YYYYMMDD> --to <YYYYMMDD> [--times HH:MM-HH:MM] [-d]");
    console.log("示例:");
    console.log("  node diff-ten-min-sum.js --name 声迅转债 --from 20260101 --to 20260703");
    console.log("  node diff-ten-min-sum.js --name 127080 --from 20260701 --to 20260703 --times 10:30-13:10");
    console.log("  node diff-ten-min-sum.js --name 超达转债 --from 2026 --times 09:35-09:45 -d");
    console.log("\n默认时段: 09:30-09:40");
    process.exit(1);
  }

  if (!opts.to) {
    const now = new Date();
    opts.to = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
  }

  console.log(`\n可转债分时差值计算`);
  const idStr = opts.code || opts.name;
  console.log(`参数: code/name=${idStr}, from=${opts.from}, to=${opts.to}, times=${opts.timeStart}-${opts.timeEnd}\n`);
  console.log(`提示: ${opts.timeStart}用对应K线开盘价, ${opts.timeEnd}用对应K线收盘价\n`);

  try {
    const startTime = Date.now();
    const result = await calcTenMinSum(opts);
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

module.exports = { calcTenMinSum };



// # 默认 09:30→09:40
// node minutes-diff-sum.js --name 127080 --from 20260701 --to 20260703

// # 自定义时段
// node minutes-diff-sum.js --name 声迅转债 --from 20260620 --to 20260703 --times "10:30-13:10" -d

// # 尾盘5分钟
// node minutes-diff-sum.js --name 127080 --from 2026 --times "14:55-15:00"
// 参数	说明
// --times 09:30-09:40	默认值，开盘后10分钟差值
// --times 10:30-13:10	早盘价 vs 下午开盘价差值
// --times 14:55-15:00	尾盘最后5分钟差值