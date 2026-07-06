/**
 * minutes-diff-sum-with-turnover-rate.js - 高换手率后次日分时差值计算
 *
 * 计算规则: 当日换手率高于阈值时，次日(time_end价格 - time_start价格)，输出差值总和
 * 换手率 = 成交量(手) / 实际发行量(亿元) / 1000  (%)
 * 数据源: akshare bond_zh_hs_cov_daily + stock_zh_a_hist_min_em
 *
 * 用法:
 *   node minutes-diff-sum-with-turnover-rate.js --name 声迅转债 --from 20260101 --to 20260703
 *   node minutes-diff-sum-with-turnover-rate.js --name 127080 --from 2026 --turnover 200
 *   node minutes-diff-sum-with-turnover-rate.js --name 超达转债 --from 20260101 --to 20260703 --times 10:30-13:10 -d
 */

const { spawn } = require("child_process");
const path = require("path");

const PY_SCRIPT = path.join(__dirname, "cb_minutes_diff_sum_with_turnover_rate.py");
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
 * 计算高换手率次日分时差值
 */
function calcDiffSum(opts = {}) {
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
      "--turnover", String(opts.turnover || 100),
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
 * 格式化输出
 */
function printResult(result, showDetails) {
  const sep = "=".repeat(72);
  const timeLabel = `${result.time_start} → ${result.time_end}`;

  console.log(`\n${sep}`);
  console.log(
    `  ${result.code} 高换手率(>${result.turnover_threshold}%)次日分时差值 (${timeLabel})`
  );
  console.log(
    `  发行规模: ${result.scale} 亿 | 区间: ${result.from_date} ~ ${result.to_date} | 交易日: ${result.total_trading_days} | 触发: ${result.trigger_days} | 有效: ${result.valid_days}`
  );
  console.log(sep);
  console.log(
    `  首日收盘: ${result.first_close.toFixed(3)}  →  末日收盘: ${result.last_close.toFixed(3)}  |  区间涨跌: ${result.price_change > 0 ? "+" : ""}${result.price_change.toFixed(3)}`
  );
  console.log(
    `  正差值: ${result.positive_count} | 负差值: ${result.negative_count} | 零: ${result.zero_count}`
  );
  if (result.no_min_data > 0 || result.no_bar > 0) {
    console.log(
      `  ⚠ 无分钟数据: ${result.no_min_data} 次 | 缺少目标bar: ${result.no_bar} 次`
    );
  }
  if (result.max_positive) {
    console.log(
      `  最大正: ${result.max_positive.diff} (触发: ${result.max_positive.trigger_date} → ${result.max_positive.next_date} | 换手率: ${result.max_positive.turnover}%)`
    );
  }
  if (result.max_negative) {
    console.log(
      `  最大负: ${result.max_negative.diff} (触发: ${result.max_negative.trigger_date} → ${result.max_negative.next_date} | 换手率: ${result.max_negative.turnover}%)`
    );
  }
  console.log(`  差值总和: ${result.total > 0 ? "+" : ""}${result.total.toFixed(3)}`);
  console.log("  注: 分钟数据覆盖约近1个月，更早日期可能无数据");
  console.log(sep);

  if (showDetails && result.details && result.details.length > 0) {
    const ts = result.time_start.padStart(5);
    const te = result.time_end.padStart(5);
    console.log(
      `\n  ${"触发日".padEnd(12)} ${"→ 次日".padEnd(12)} ${"换手%".padStart(8)} ${"收盘".padStart(10)} ${ts.padStart(10)} ${te.padStart(10)} ${"差值".padStart(10)}`
    );
    console.log("  " + "-".repeat(72));

    result.details.forEach((d) => {
      let mark = "";
      if (result.max_positive && d.diff === result.max_positive.diff) mark = " ★ 最大正";
      else if (result.max_negative && d.diff === result.max_negative.diff) mark = " ▼ 最大负";

      console.log(
        `  ${d.trigger_date.padEnd(12)} ${d.next_date.padEnd(12)} ${d.turnover.toFixed(1).padStart(8)}% ${d.close.toFixed(3).padStart(10)} ${d.price_start.toFixed(3).padStart(10)} ${d.price_end.toFixed(3).padStart(10)} ${d.diff > 0 ? "+" : ""}${d.diff.toFixed(3).padStart(9)}${mark}`
      );
    });

    console.log(`\n${sep}\n`);
  }
}

// ============ 主流程 ============
async function main() {
  const args = process.argv.slice(2);
  const opts = { name: "", code: "", from: "", to: "", timeStart: "09:30", timeEnd: "09:40", turnover: 100 };
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
    } else if (args[i] === "--turnover" && args[i + 1]) {
      opts.turnover = parseFloat(args[i + 1]);
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
    console.log("用法: node minutes-diff-sum-with-turnover-rate.js --name <转债名称或代码> --from <YYYYMMDD> --to <YYYYMMDD> [选项]");
    console.log("选项:");
    console.log("  --times HH:MM-HH:MM    时间段 (默认 09:30-09:40)");
    console.log("  --turnover N            换手率阈值%，默认100");
    console.log("  -d, --detail            显示每日明细");
    console.log("示例:");
    console.log("  node minutes-diff-sum-with-turnover-rate.js --name 声迅转债 --from 20260101 --to 20260703");
    console.log("  node minutes-diff-sum-with-turnover-rate.js --name 127080 --from 2026 --turnover 200");
    console.log("  node minutes-diff-sum-with-turnover-rate.js --name 超达转债 --from 2026 --times 10:30-13:10 -d");
    process.exit(1);
  }

  if (!opts.to) {
    const now = new Date();
    opts.to = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
  }

  console.log(`\n高换手率次日分时差值计算`);
  const idStr = opts.code || opts.name;
  console.log(`参数: code/name=${idStr}, from=${opts.from}, to=${opts.to}, times=${opts.timeStart}-${opts.timeEnd}, turnover>${opts.turnover}%\n`);

  try {
    const startTime = Date.now();
    const result = await calcDiffSum(opts);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    if (result.error) {
      console.log(`\n提示: ${result.error}`);
      console.log(`耗时: ${elapsed}s`);
      process.exit(0);
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

module.exports = { calcDiffSum };




// 换手率 = 成交量(手) / 实际发行量(亿元) / 1000   (单位: %)

// 当某日换手率 > 阈值时：
//   次日差值 = 次日(time_end价格 - time_start价格)
//   总差异 = sum(所有差值)




// # 默认：换手率>100%，时段 09:30→09:40
// node minutes-diff-sum-with-turnover-rate.js --name 127080 --from 20260101 --to 20260703

// # 更高阈值 + 显示明细
// node minutes-diff-sum-with-turnover-rate.js --name 声迅转债 --from 2026 --turnover 200 -d

// # 自定义时段 + 自定义阈值
// node minutes-diff-sum-with-turnover-rate.js --name 超达转债 --from 2026 --times "10:30-13:10" --turnover 300
