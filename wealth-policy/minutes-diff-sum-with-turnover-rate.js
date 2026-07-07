/**
 * minutes-diff-sum-with-turnover-rate.js - 高换手率后次日分时差值计算
 *
 * 计算规则: 当日换手率高于阈值时，次日(time_end价格 - time_start价格)，输出差值总和
 * 同时输出百分比差值: (pct_end - pct_start)，其中 pct = (价格 - 开盘价) / 开盘价 * 100
 * 换手率 = 成交量(手) / 实际发行量(亿元) / 1000  (%)
 * 数据源: akshare bond_zh_hs_cov_daily + stock_zh_a_minute (新浪)
 *
 * 用法:
 *   node minutes-diff-sum-with-turnover-rate.js --name 声迅转债 --from 20260101 --to 20260703
 *   node minutes-diff-sum-with-turnover-rate.js --name 127080 --from 2026 --turnover 200
 *   node minutes-diff-sum-with-turnover-rate.js --name 超达转债 --from 20260101 --to 20260703 --times 10:30-13:10 -d
 *   node minutes-diff-sum-with-turnover-rate.js --name 127080 --from 2026 --mode pct -d
 */

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

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
 * 计算高换手率次日分时差值
 */
function calcDiffSum(opts = {}) {
  return new Promise((resolve, reject) => {
    const tmpFile = path.join(os.tmpdir(), `cb_result_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.json`);

    const args = [
      PYTHON, "-u", PY_SCRIPT,
      "--from", opts.from,
      "--to", opts.to,
      "--time-start", opts.timeStart || "09:30",
      "--time-end", opts.timeEnd || "09:40",
      "--turnover", String(opts.turnover || 100),
    ];

    if (opts.code) {
      args.push("--code", opts.code);
    } else if (opts.name) {
      args.push("--name", opts.name);
    }

    const proc = spawn(args[0], args.slice(1), {
      stdio: ["ignore", "ignore", "pipe"],  // stdout 忽略，结果走临时文件
      env: { ...process.env, PYTHONIOENCODING: "utf-8", TQDM_DISABLE: "1", CB_RESULT_FILE: tmpFile },
    });

    let stderr = "";
    let done = false;

    const finish = (err, result) => {
      if (done) return;
      done = true;
      cleanup();
      if (err) reject(err);
      else resolve(result);
    };

    // 从临时文件读取 JSON 结果
    const readResult = () => {
      if (done) return;
      try {
        if (!fs.existsSync(tmpFile)) return;
        const raw = fs.readFileSync(tmpFile, "utf-8");
        if (!raw.trim()) return;
        const parsed = JSON.parse(raw);
        finish(null, parsed);
      } catch (e) {
        // 文件可能还在写入，稍后由 close/timeout 重试
      }
    };

    proc.stderr.on("data", (chunk) => {
      const s = chunk.toString();
      stderr += s;
      process.stderr.write(s);

      // Python 写入 "结果已输出" 意味着临时文件已就绪，不等 close 事件
      if (s.includes("结果已输出")) {
        setTimeout(readResult, 200);
      }
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        finish(new Error(`Python exit ${code}\n---stderr---\n${stderr}\n---end---`));
        return;
      }
      // close 作为兜底
      if (!done) {
        setTimeout(readResult, 100);
        // 超时保护：close 后 5 秒仍无法读取则报错
        setTimeout(() => {
          if (!done) {
            finish(new Error(`结果文件读取超时: ${tmpFile}\n---stderr---\n${stderr}\n---end---`));
          }
        }, 5000);
      }
    });

    proc.on("error", (err) => {
      finish(new Error(`spawn: ${err.message}`));
    });

    function cleanup() {
      try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch (_) {}
    }
  });
}

/**
 * 格式化输出
 */
function printResult(result, showDetails, mode) {
  const sep = "=".repeat(78);
  const timeLabel = `${result.time_start} → ${result.time_end}`;
  const showPrice = mode === "price" || mode === "both";
  const showPct = mode === "pct" || mode === "both";

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
  if (result.no_min_data > 0 || result.no_bar > 0) {
    console.log(
      `  ⚠ 无分钟数据: ${result.no_min_data} 次 | 缺少目标bar: ${result.no_bar} 次`
    );
  }

  // 价格差值汇总
  if (showPrice) {
    console.log(
      `  [价格差值] 正: ${result.positive_count} | 负: ${result.negative_count} | 零: ${result.zero_count}`
    );
    console.log(
      `  价格差值总和: ${result.total > 0 ? "+" : ""}${result.total.toFixed(3)}`
    );
    if (result.max_positive) {
      console.log(
        `  最大正: ${result.max_positive.diff} (${result.max_positive.trigger_date} → ${result.max_positive.next_date} | 换: ${result.max_positive.turnover}%)`
      );
    }
    if (result.max_negative) {
      console.log(
        `  最大负: ${result.max_negative.diff} (${result.max_negative.trigger_date} → ${result.max_negative.next_date} | 换: ${result.max_negative.turnover}%)`
      );
    }
  }

  // 百分比差值汇总
  if (showPct) {
    console.log(
      `  [百分比差值] 正: ${result.pct_positive_count} | 负: ${result.pct_negative_count} | 零: ${result.pct_zero_count}`
    );
    console.log(
      `  百分比差值总和: ${result.pct_total > 0 ? "+" : ""}${result.pct_total.toFixed(3)}%`
    );
    if (result.max_pct_positive) {
      console.log(
        `  最大正%: ${result.max_pct_positive.pct_diff > 0 ? "+" : ""}${result.max_pct_positive.pct_diff}% (${result.max_pct_positive.trigger_date} → ${result.max_pct_positive.next_date})`
      );
    }
    if (result.max_pct_negative) {
      console.log(
        `  最大负%: ${result.max_pct_negative.pct_diff > 0 ? "+" : ""}${result.max_pct_negative.pct_diff}% (${result.max_pct_negative.trigger_date} → ${result.max_pct_negative.next_date})`
      );
    }
  }

  console.log("  注: 分钟数据覆盖约近2个月，更早日期可能无数据");
  console.log(sep);

  if (showDetails && result.details && result.details.length > 0) {
    const ts = result.time_start.padStart(5);
    const te = result.time_end.padStart(5);

    let header = `\n  ${"触发日".padEnd(12)} ${"→ 次日".padEnd(12)} ${"换手%".padStart(7)} ${"收盘".padStart(9)} ${ts.padStart(9)} ${te.padStart(9)} `;
    let divider = "  " + "-".repeat(76);

    if (showPrice) {
      header += `${"差值".padStart(9)}`;
    }
    if (showPct) {
      header += ` ${"涨跌%".padStart(9)}`;
    }

    console.log(header);
    console.log(divider);

    result.details.forEach((d) => {
      let line = `  ${d.trigger_date.padEnd(12)} ${d.next_date.padEnd(12)} ${d.turnover.toFixed(1).padStart(7)}% ${d.close.toFixed(3).padStart(9)} ${d.price_start.toFixed(3).padStart(9)} ${d.price_end.toFixed(3).padStart(9)} `;

      if (showPrice) {
        const diffStr = d.diff > 0 ? "+" + d.diff.toFixed(3) : d.diff.toFixed(3);
        line += `${diffStr.padStart(9)}`;
      }
      if (showPct) {
        const pd = d.pct_diff > 0 ? "+" + d.pct_diff.toFixed(2) : d.pct_diff.toFixed(2);
        line += ` ${pd.padStart(9)}%`;
      }

      // 标记极值
      const marks = [];
      if (showPrice && result.max_positive && d.diff === result.max_positive.diff) marks.push("价格最大正");
      if (showPrice && result.max_negative && d.diff === result.max_negative.diff) marks.push("价格最大负");
      if (showPct && result.max_pct_positive && d.pct_diff === result.max_pct_positive.pct_diff) marks.push("%最大正");
      if (showPct && result.max_pct_negative && d.pct_diff === result.max_pct_negative.pct_diff) marks.push("%最大负");
      if (marks.length > 0) line += `  ◆ ${marks.join(", ")}`;

      console.log(line);
    });

    console.log(`\n${sep}\n`);
  }
}

// ============ 主流程 ============
async function main() {
  const args = process.argv.slice(2);
  const opts = { name: "", code: "", from: "", to: "", timeStart: "09:30", timeEnd: "09:40", turnover: 100 };
  let showDetails = false;
  let mode = "both";  // price | pct | both

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
    } else if (args[i] === "--mode" && args[i + 1]) {
      const m = args[i + 1].toLowerCase();
      if (["price", "pct", "both"].includes(m)) {
        mode = m;
      } else {
        console.error(`错误: --mode 参数必须为 price/pct/both，当前: "${args[i + 1]}"`);
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
    console.log("用法: node minutes-diff-sum-with-turnover-rate.js --name <转债名称或代码> --from <YYYYMMDD> --to <YYYYMMDD> [选项]");
    console.log("选项:");
    console.log("  --times HH:MM-HH:MM    时间段 (默认 09:30-09:40)");
    console.log("  --turnover N            换手率阈值%，默认100");
    console.log("  --mode price|pct|both   输出模式 (默认 both)");
    console.log("      price  仅显示价格差值");
    console.log("      pct    仅显示百分比差值 (基于次日开盘价)");
    console.log("      both   同时显示价格和百分比差值");
    console.log("  -d, --detail            显示每日明细");
    console.log("示例:");
    console.log("  node minutes-diff-sum-with-turnover-rate.js --name 声迅转债 --from 20260101 --to 20260703");
    console.log("  node minutes-diff-sum-with-turnover-rate.js --name 127080 --from 2026 --turnover 200");
    console.log("  node minutes-diff-sum-with-turnover-rate.js --name 127080 --from 2026 --mode pct -d");
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

    printResult(result, showDetails, mode);
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




// ============ 计算说明 ============

// 换手率 = 成交量(手) / 实际发行量(亿元) / 1000   (单位: %)

// 当某日换手率 > 阈值时：
//   次日价格差值 = time_end价格 - time_start价格
//   次日百分比差值 = pct_end(%) - pct_start(%)
//     其中 pct_start  = (price_start - 次日开盘价) / 次日开盘价 * 100
//          pct_end    = (price_end   - 次日开盘价) / 次日开盘价 * 100
//   总价格差值 = sum(所有价格差值)
//   总百分比差值 = sum(所有百分比差值)


// # 默认 (both)：同时显示价格差值和百分比差值
// node minutes-diff-sum-with-turnover-rate.js --name 127080 --from 2026 -d

// # 只看百分比差值
// node minutes-diff-sum-with-turnover-rate.js --name 127080 --from 2026 --mode pct -d

// # 只看价格差值（和之前一样）
// node minutes-diff-sum-with-turnover-rate.js --name 127080 --from 2026 --mode price

// # 高阈值 + 明细 + 百分比
// node minutes-diff-sum-with-turnover-rate.js --name 声迅转债 --from 2026 --turnover 200 --mode pct -d

// node minutes-diff-sum-with-turnover-rate.js --name 大中转债 --from 20260628 --to 20260707 --turnover 10 --mode pct -d
// node minutes-diff-sum-with-turnover-rate.js --name 大中转债 --from 2026 --turnover 10 --mode pct -d