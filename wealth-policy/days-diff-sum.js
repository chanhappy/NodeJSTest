/**
 * diff-sum.js - 可转债隔夜跳空差值计算工具
 *
 * 计算规则: sum(次日开盘价 - 当日收盘价)
 * 数据源: akshare → bond_zh_hs_cov_daily
 *
 * 用法:
 *   node diff-sum.js --name 声迅转债 --from 20260101 --to 20260703
 *   node diff-sum.js --name 127080 --from 20260101 --to 20260703
 *   node diff-sum.js --name 超达转债 --from 2026
 */

const { spawn } = require("child_process");
const path = require("path");

const PY_SCRIPT = path.join(__dirname, "cb_days-diff-sum.py");
const PYTHON = "python";

/**
 * 调用 Python 计算隔夜跳空差值
 * @param {Object} opts - { name, from, to }
 * @returns {Promise<Object>}
 */
function calcDiffSum(opts = {}) {
  return new Promise((resolve, reject) => {
    const args = [PY_SCRIPT, "--name", opts.name];
    if (opts.from) args.push("--from", opts.from);
    if (opts.to) args.push("--to", opts.to);

    const proc = spawn(PYTHON, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

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

    proc.on("error", (err) => {
      reject(new Error(`无法启动 Python: ${err.message}`));
    });
  });
}

/**
 * 格式化输出结果
 */
function printResult(result, showDetails) {
  const sep = "=".repeat(72);

  console.log(`\n${sep}`);
  console.log(
    `  ${result.name}（${result.code}）隔夜跳空差值计算`
  );
  console.log(
    `  区间: ${result.from_date} ~ ${result.to_date} | 交易日: ${result.trading_days} | 差值对: ${result.pairs}`
  );
  console.log(sep);
  console.log(
    `  首日收盘: ${result.first_close.toFixed(3)}  →  末日收盘: ${result.last_close.toFixed(3)}  |  区间涨跌: ${result.price_change > 0 ? "+" : ""}${result.price_change.toFixed(3)}`
  );
  console.log(
    `  正差值: ${result.positive_count} 天  |  负差值: ${result.negative_count} 天  |  零差值: ${result.pairs - result.positive_count - result.negative_count} 天`
  );
  console.log(`  最大正差: ${result.max_positive.diff}（${result.max_positive.date} → ${result.max_positive.next_date}）`);
  console.log(`  最大负差: ${result.max_negative.diff}（${result.max_negative.date} → ${result.max_negative.next_date}）`);
  console.log(`  差值总和: ${result.total > 0 ? "+" : ""}${result.total.toFixed(3)}`);
  console.log(sep);

  if (showDetails && result.details && result.details.length > 0) {
    console.log(
      `\n  ${"日期".padEnd(12)} ${"→ 次日".padEnd(12)} ${"收盘".padStart(10)} ${"开盘".padStart(10)} ${"差值".padStart(10)}  ${"标记"}`
    );
    console.log("  " + "-".repeat(68));

    result.details.forEach((d) => {
      let mark = "";
      if (d.diff === result.max_positive.diff) mark = "★ 最大正";
      else if (d.diff === result.max_negative.diff) mark = "▼ 最大负";

      console.log(
        `  ${d.date.padEnd(12)} ${d.next_date.padEnd(12)} ${d.close.toFixed(3).padStart(10)} ${d.next_open.toFixed(3).padStart(10)} ${d.diff > 0 ? "+" : ""}${d.diff.toFixed(3).padStart(9)}  ${mark}`
      );
    });

    console.log(`\n${sep}\n`);
  }
}

// ============ 主流程 ============
async function main() {
  const args = process.argv.slice(2);
  const opts = { name: "", from: "", to: "" };
  let showDetails = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--name" && args[i + 1]) {
      opts.name = args[i + 1];
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

  // 快捷年份模式: --name xxx --from 2026 → 自动补全 from=20260101, to=20261231
  if (opts.from && opts.from.length === 4 && /^\d{4}$/.test(opts.from)) {
    opts.to = opts.to || `${opts.from}1231`;
    opts.from = `${opts.from}0101`;
  }

  if (!opts.name) {
    console.log("用法: node diff-sum.js --name <转债名称或代码> --from <YYYYMMDD> --to <YYYYMMDD> [-d]");
    console.log("示例:");
    console.log("  node diff-sum.js --name 声迅转债 --from 20260101 --to 20260703");
    console.log("  node diff-sum.js --name 127080 --from 2026          # 快捷年份模式");
    console.log("  node diff-sum.js --name 超达转债 --from 20260101 --to 20260703 -d  # 显示明细");
    process.exit(1);
  }

  // 如果没有指定 to，默认到今天
  if (!opts.to) {
    const now = new Date();
    opts.to = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
  }

  console.log(`\n可转债隔夜跳空差值计算`);
  console.log(`参数: name=${opts.name}, from=${opts.from}, to=${opts.to}\n`);

  try {
    const startTime = Date.now();
    const result = await calcDiffSum(opts);
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

module.exports = { calcDiffSum };



// # 基本用法：名称 + 日期区间
// node diff-sum.js --name 声迅转债 --from 20260101 --to 20260703

// # 快捷年份模式：--from 2026 自动补全整年
// node diff-sum.js --name 超达转债 --from 2026

// # 用代码代替名称
// node diff-sum.js --name 127080 --from 20260101 --to 20260703

// # 显示每日明细（-d）
// node diff-sum.js --name 蓝晓转02 --from 2026 -d
