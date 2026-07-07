# -*- coding: utf-8 -*-
"""
可转债高换手率后次日分时差值计算
规则: 当日换手率超过阈值时，次日 time_end价格 - time_start价格，输出差值总和
换手率 = 成交量(手) / 实际发行量(亿元) / 1000
数据: bond_zh_hs_cov_daily (日线) + stock_zh_a_minute (新浪5分钟K线，一次调用，避免东方财富限流)
用法:
  python cb_minutes_diff_sum_with_turnover_rate.py --code 127080 --from 20260101 --to 20260703 --turnover 100
  python cb_minutes_diff_sum_with_turnover_rate.py --code 127080 --from 20260101 --to 20260703 --turnover 200 --time-start 10:30 --time-end 13:10
"""
import sys
import os
import json
import argparse
from datetime import datetime

# 输出初始化提示，避免 akshare 加载期间用户误以为卡死
sys.stderr.write("正在初始化 Python 环境...\n")
sys.stderr.flush()

import akshare as ak
import pandas as pd

sys.stderr.write("akshare 加载完成\n")
sys.stderr.flush()


def add_minutes(time_str, minutes):
    """给 HH:MM 时间字符串加分钟数"""
    h, m = map(int, time_str.split(":"))
    total = h * 60 + m + minutes
    new_h = (total // 60) % 24
    new_m = total % 60
    return f"{new_h:02d}:{new_m:02d}"


def log_stderr(msg):
    """写 stderr 并立即 flush，确保管道实时输出"""
    sys.stderr.write(msg + "\n")
    sys.stderr.flush()


def get_scale(code):
    """获取可转债实际发行量（亿元）"""
    try:
        log_stderr("正在获取发行规模...")
        info = ak.bond_zh_cov_info_ths()
        row = info[info["债券代码"].astype(str) == code]
        if len(row) > 0:
            scale = float(row.iloc[0]["实际发行量"])
            log_stderr(f"发行规模: {scale} 亿元")
            return scale
    except Exception as e:
        log_stderr(f"获取规模失败: {e}")
    return None


def calc_turnover(volume, scale):
    """换手率(%) = volume(张) / scale(亿元) / 10000"""
    if scale is None or scale <= 0:
        return 0.0
    return round(volume / scale / 10000, 2)


def get_time_diff_with_turnover(code, from_date, to_date,
                                 time_start="09:30", time_end="09:40",
                                 turnover_threshold=100.0):
    """
    计算高换手率次日分时差值并求和

    code: 可转债代码
    from_date / to_date: YYYYMMDD
    time_start / time_end: HH:MM
    turnover_threshold: 换手率阈值（%），默认100
    """
    prefix = "sh" if code.startswith("11") else "sz"
    symbol_full = f"{prefix}{code}"

    # bar对齐
    bar_start_time = add_minutes(time_start, 5)
    bar_end_time = time_end

    log_stderr(
        f"查询: {code} {from_date} ~ {to_date}\n"
        f"  时段: {time_start} -> {time_end} | bar: {bar_start_time}(开) -> {bar_end_time}(收)\n"
        f"  换手率阈值: >{turnover_threshold}%"
    )

    # 1. 获取发行规模
    scale = get_scale(code)
    if scale is None:
        log_stderr("无法获取发行规模，退出")
        return None

    # 2. 获取日线数据
    log_stderr("正在获取日线数据...")
    df_daily = ak.bond_zh_hs_cov_daily(symbol=symbol_full)
    if df_daily.empty:
        log_stderr("日线数据为空")
        return None

    df_daily["date"] = pd.to_datetime(df_daily["date"])
    df_daily = df_daily.sort_values("date").reset_index(drop=True)

    from_fmt = datetime.strptime(from_date, "%Y%m%d")
    to_fmt = datetime.strptime(to_date, "%Y%m%d")
    mask = (df_daily["date"] >= from_fmt) & (df_daily["date"] <= to_fmt)
    df_range = df_daily[mask].reset_index(drop=True)

    if len(df_range) < 2:
        log_stderr(f"区间内交易日不足2天（共 {len(df_range)} 天）")
        return None

    log_stderr(f"区间交易日: {len(df_range)} 天")

    # 3. 计算每日换手率并筛选高换手率日
    log_stderr("日期        成交量(raw)  计算换手率%")
    trigger_days = []
    for i in range(len(df_range) - 1):  # 最后一天无次日，不检查
        row = df_range.iloc[i]
        vol = float(row["volume"])
        turnover = calc_turnover(vol, scale)
        date_key = row["date"].strftime("%Y%m%d")
        log_stderr(f"  {date_key}  {vol:.0f}  {turnover:.2f}%")
        if turnover > turnover_threshold:
            close_price = float(row["close"])
            trigger_days.append({
                "date": date_key,
                "close": close_price,
                "volume": vol,
                "turnover": turnover,
            })

    log_stderr(f"高换手率触发: {len(trigger_days)} 天 / 共 {len(df_range)-1} 个可配对日")

    if len(trigger_days) == 0:
        log_stderr("无触发日")
        return None

    # 4. 获取每个触发日的次日日期
    trigger_date_set = {t["date"] for t in trigger_days}
    next_dates_map = {}  # trigger_date -> next_date
    for i in range(len(df_range) - 1):
        d = df_range.iloc[i]["date"].strftime("%Y%m%d")
        if d in trigger_date_set:
            nd = df_range.iloc[i + 1]["date"].strftime("%Y%m%d")
            next_dates_map[d] = nd

    next_dates_set = set(next_dates_map.values())

    # 5. 一次性获取所有可用的5分钟K线数据（新浪接口）
    log_stderr("获取5分钟K线数据（新浪）...")
    try:
        df_min = ak.stock_zh_a_minute(symbol=symbol_full, period="5")
    except Exception as e:
        log_stderr(f"分钟数据获取失败: {e}")
        return None

    if df_min.empty:
        log_stderr("分钟数据为空")
        return None

    # 新浪的 day 字段是 datetime，格式如 "2026-05-07 09:35:00"
    df_min["day"] = pd.to_datetime(df_min["day"])
    df_min["date_str"] = df_min["day"].dt.strftime("%Y%m%d")
    df_min["time_str"] = df_min["day"].dt.strftime("%H:%M")

    data_start = df_min["date_str"].min()
    data_end = df_min["date_str"].max()
    log_stderr(f"分钟数据范围: {data_start} ~ {data_end} ({len(df_min)} 条)")

    # 只保留目标次日的数据
    df_min_target = df_min[df_min["date_str"].isin(next_dates_set)].copy()
    log_stderr(f"匹配次日分钟数据: {len(df_min_target)} 条 / {len(next_dates_set)} 个目标日")

    # 6. 计算每个触发日的差值
    total = 0.0
    pct_total = 0.0
    details = []
    no_min_data = 0
    no_bar = 0
    out_of_range = 0

    for t in trigger_days:
        trigger_date = t["date"]
        next_date = next_dates_map.get(trigger_date)
        if next_date is None:
            no_min_data += 1
            continue

        next_open = None
        for j in range(len(df_range)):
            if df_range.iloc[j]["date"].strftime("%Y%m%d") == next_date:
                next_open = float(df_range.iloc[j]["open"])
                break

        # 从分钟数据中找次日的 bar
        day_data = df_min_target[df_min_target["date_str"] == next_date]
        if day_data.empty:
            # 判断是否超出新浪覆盖范围
            if next_date < data_start or next_date > data_end:
                out_of_range += 1
            else:
                no_min_data += 1
            continue

        bar_start = day_data[day_data["time_str"] == bar_start_time]
        bar_end = day_data[day_data["time_str"] == bar_end_time]

        if bar_start.empty or bar_end.empty:
            no_bar += 1
            continue

        price_start = float(bar_start.iloc[0]["open"])
        price_end = float(bar_end.iloc[0]["close"])
        diff = round(price_end - price_start, 3)

        # 百分比差值（基于次日开盘价）
        # pct_start = time_start时刻相对开盘价涨跌幅(%)
        # pct_end   = time_end时刻相对开盘价涨跌幅(%)
        # pct_diff  = pct_end - pct_start = (price_end - price_start) / 开盘价 * 100
        if next_open and next_open > 0:
            pct_start = round((price_start - next_open) / next_open * 100, 3)
            pct_end = round((price_end - next_open) / next_open * 100, 3)
            pct_diff = round(pct_end - pct_start, 3)
        else:
            pct_start = 0.0
            pct_end = 0.0
            pct_diff = 0.0

        total += diff
        pct_total += pct_diff

        details.append({
            "trigger_date": trigger_date,
            "next_date": next_date,
            "turnover": t["turnover"],
            "close": t["close"],
            "next_open": next_open,
            "price_start": price_start,
            "price_end": price_end,
            "diff": diff,
            "pct_start": pct_start,
            "pct_end": pct_end,
            "pct_diff": pct_diff,
        })

    log_stderr(
        f"结果: 有效 {len(details)} 次, 超出范围 {out_of_range} 次, "
        f"无分钟数据 {no_min_data} 次, 缺bar {no_bar} 次"
    )

    if len(details) == 0:
        log_stderr("details 为空，返回 None")
        return None

    try:
        log_stderr("正在构建结果...")
        max_pos = max(details, key=lambda x: x["diff"])
        max_neg = min(details, key=lambda x: x["diff"])
        max_pct_pos = max(details, key=lambda x: x["pct_diff"])
        max_pct_neg = min(details, key=lambda x: x["pct_diff"])
        pos_count = sum(1 for d in details if d["diff"] > 0)
        neg_count = sum(1 for d in details if d["diff"] < 0)
        pct_pos_count = sum(1 for d in details if d["pct_diff"] > 0)
        pct_neg_count = sum(1 for d in details if d["pct_diff"] < 0)

        first_close = float(df_range.iloc[0]["close"])
        last_close = float(df_range.iloc[-1]["close"])
        price_change = round(last_close - first_close, 3)

        result = {
            "code": code,
            "scale": scale,
            "time_start": time_start,
            "time_end": time_end,
            "turnover_threshold": turnover_threshold,
            "from_date": from_date,
            "to_date": to_date,
            "total_trading_days": len(df_range),
            "trigger_days": len(trigger_days),
            "valid_days": len(details),
            "no_min_data": no_min_data + out_of_range,
            "no_bar": no_bar,
            "total": round(total, 3),
            "pct_total": round(pct_total, 3),
            "first_close": first_close,
            "last_close": last_close,
            "price_change": price_change,
            "positive_count": pos_count,
            "negative_count": neg_count,
            "zero_count": len(details) - pos_count - neg_count,
            "pct_positive_count": pct_pos_count,
            "pct_negative_count": pct_neg_count,
            "pct_zero_count": len(details) - pct_pos_count - pct_neg_count,
            "max_positive": {"trigger_date": max_pos["trigger_date"], "next_date": max_pos["next_date"],
                             "turnover": max_pos["turnover"], "diff": max_pos["diff"], "pct_diff": max_pos["pct_diff"]},
            "max_negative": {"trigger_date": max_neg["trigger_date"], "next_date": max_neg["next_date"],
                             "turnover": max_neg["turnover"], "diff": max_neg["diff"], "pct_diff": max_neg["pct_diff"]},
            "max_pct_positive": {"trigger_date": max_pct_pos["trigger_date"], "next_date": max_pct_pos["next_date"],
                                 "turnover": max_pct_pos["turnover"], "pct_diff": max_pct_pos["pct_diff"]},
            "max_pct_negative": {"trigger_date": max_pct_neg["trigger_date"], "next_date": max_pct_neg["next_date"],
                                 "turnover": max_pct_neg["turnover"], "pct_diff": max_pct_neg["pct_diff"]},
            "details": details,
        }
        log_stderr("结果构建完成")
        return result
    except Exception as e:
        log_stderr(f"构建结果时异常: {e}")
        import traceback
        log_stderr(traceback.format_exc())
        return None


def resolve_code(name_or_code):
    """通过名称或代码查可转债代码。如果是纯数字直接返回，否则按名称模糊匹配"""
    if name_or_code.isdigit():
        return name_or_code
    log_stderr(f"正在查找转债: {name_or_code} ...")
    spot = ak.bond_zh_hs_cov_spot()
    spot = spot[~spot["symbol"].str.startswith("bj")]
    matches = spot[spot["name"].str.contains(name_or_code, na=False)]
    if len(matches) == 0:
        return None
    sym = str(matches.iloc[0]["symbol"])
    return sym[2:] if len(sym) > 2 else sym


def _output_result(data):
    """输出结果：优先写入 CB_RESULT_FILE 环境变量指定的临时文件"""
    result_file = os.environ.get("CB_RESULT_FILE", "")
    if result_file:
        try:
            with open(result_file, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
            sys.stdout.write("OK:" + result_file + "\n")
            sys.stdout.flush()
            return
        except Exception as e:
            log_stderr(f"写临时文件失败: {e}，回退到 stdout")
    # 兜底：直接写 stdout
    output = json.dumps(data, ensure_ascii=False, indent=2)
    sys.stdout.write(output + "\n")
    sys.stdout.flush()


def main():
    parser = argparse.ArgumentParser(description="高换手率次日分时差值计算")
    parser.add_argument("--code", type=str, default="", help="可转债代码")
    parser.add_argument("--name", type=str, default="", help="可转债名称（模糊匹配）")
    parser.add_argument("--from", dest="from_date", type=str, required=True)
    parser.add_argument("--to", dest="to_date", type=str, required=True)
    parser.add_argument("--time-start", type=str, default="09:30")
    parser.add_argument("--time-end", type=str, default="09:40")
    parser.add_argument("--turnover", type=float, default=100.0,
                        help="换手率阈值（%，默认100）")
    args = parser.parse_args()

    code = args.code
    if not code and args.name:
        code = resolve_code(args.name)
        if code is None:
            _output_result({"error": f"未找到转债: {args.name}"})
            return
    if not code:
        _output_result({"error": "请指定 --code 或 --name"})
        return

    try:
        result = get_time_diff_with_turnover(
            code, args.from_date, args.to_date,
            args.time_start, args.time_end, args.turnover
        )
    except Exception as e:
        log_stderr(f"计算过程异常: {e}")
        import traceback
        log_stderr(traceback.format_exc())
        _output_result({"error": f"计算异常: {e}"})
        return

    if result is None:
        log_stderr("result 为 None，输出错误提示")
        _output_result({"error": "无有效数据（可能所有触发日均无分钟数据）"})
        return

    log_stderr(f"准备输出结果: {len(result.get('details', []))} 条明细")
    _output_result(result)
    log_stderr("结果已输出")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log_stderr(f"main() 未捕获异常: {e}")
        import traceback
        log_stderr(traceback.format_exc())
        _output_result({"error": f"运行异常: {e}"})
    finally:
        sys.exit(0)
