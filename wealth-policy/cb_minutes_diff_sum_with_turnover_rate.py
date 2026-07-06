# -*- coding: utf-8 -*-
"""
可转债高换手率后次日分时差值计算
规则: 当日换手率超过阈值时，次日 time_end价格 - time_start价格，输出差值总和
换手率 = 成交量(手) / 实际发行量(亿元) / 100000 * 100% = volume / scale / 1000
数据: bond_zh_hs_cov_daily (日线) + stock_zh_a_hist_min_em (5分钟K线)
用法:
  python cb_minutes_diff_sum_with_turnover_rate.py --code 127080 --from 20260101 --to 20260703 --turnover 100
  python cb_minutes_diff_sum_with_turnover_rate.py --code 127080 --from 20260101 --to 20260703 --turnover 200 --time-start 10:30 --time-end 13:10
"""
import sys
import json
import argparse
import time
from datetime import datetime
import akshare as ak
import pandas as pd


def add_minutes(time_str, minutes):
    """给 HH:MM 时间字符串加分钟数"""
    h, m = map(int, time_str.split(":"))
    total = h * 60 + m + minutes
    new_h = (total // 60) % 24
    new_m = total % 60
    return f"{new_h:02d}:{new_m:02d}"


def get_scale(code):
    """获取可转债实际发行量（亿元）"""
    try:
        info = ak.bond_zh_cov_info_ths()
        row = info[info["债券代码"].astype(str) == code]
        if len(row) > 0:
            scale = float(row.iloc[0]["实际发行量"])
            sys.stderr.write(f"发行规模: {scale} 亿元\n")
            return scale
    except Exception as e:
        sys.stderr.write(f"获取规模失败: {e}\n")
    return None


def calc_turnover(volume, scale):
    """换手率(%) = volume(手) / scale(亿元) / 1000"""
    if scale is None or scale <= 0:
        return 0.0
    return round(volume / scale / 1000, 2)


def fetch_min_data(code, date_str, time_start, query_end_time, retries=3):
    """带重试的分钟数据获取"""
    for attempt in range(retries):
        try:
            df = ak.stock_zh_a_hist_min_em(
                symbol=code, period="5",
                start_date=f"{date_str} {time_start}:00",
                end_date=f"{date_str} {query_end_time}:00",
                adjust=""
            )
            return df
        except Exception:
            if attempt < retries - 1:
                time.sleep(2.0 * (attempt + 1))
    return None


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

    sys.stderr.write(
        f"查询: {code} {from_date} ~ {to_date}\n"
        f"  时段: {time_start} -> {time_end} | bar: {bar_start_time}(开) -> {bar_end_time}(收)\n"
        f"  换手率阈值: >{turnover_threshold}%\n"
    )

    # 1. 获取发行规模
    scale = get_scale(code)
    if scale is None:
        sys.stderr.write("无法获取发行规模，退出\n")
        return None

    # 2. 获取日线数据
    df_daily = ak.bond_zh_hs_cov_daily(symbol=symbol_full)
    if df_daily.empty:
        sys.stderr.write("日线数据为空\n")
        return None

    df_daily["date"] = pd.to_datetime(df_daily["date"])
    df_daily = df_daily.sort_values("date").reset_index(drop=True)

    from_fmt = datetime.strptime(from_date, "%Y%m%d")
    to_fmt = datetime.strptime(to_date, "%Y%m%d")
    mask = (df_daily["date"] >= from_fmt) & (df_daily["date"] <= to_fmt)
    df_range = df_daily[mask].reset_index(drop=True)

    if len(df_range) < 2:
        sys.stderr.write(f"区间内交易日不足2天（共 {len(df_range)} 天）\n")
        return None

    sys.stderr.write(f"区间交易日: {len(df_range)} 天\n")

    # 3. 计算每日换手率并筛选高换手率日
    trigger_days = []
    for i in range(len(df_range) - 1):  # 最后一天无次日，不检查
        row = df_range.iloc[i]
        vol = float(row["volume"])
        turnover = calc_turnover(vol, scale)
        if turnover > turnover_threshold:
            date_key = df_range.iloc[i]["date"].strftime("%Y%m%d")
            close_price = float(row["close"])
            trigger_days.append({
                "date": date_key,
                "close": close_price,
                "volume": vol,
                "turnover": turnover,
            })

    sys.stderr.write(f"高换手率触发: {len(trigger_days)} 天 / 共 {len(df_range)-1} 个可配对日\n")

    if len(trigger_days) == 0:
        sys.stderr.write("无触发日\n")
        return None

    # 4. 对每个触发日，查次日分时差值
    query_end_time = add_minutes(bar_end_time, 5)
    total = 0.0
    details = []
    no_min_data = 0
    no_bar = 0

    for idx, t in enumerate(trigger_days):
        trigger_date = t["date"]
        # 找次日在 df_range 中的位置
        trigger_dt = datetime.strptime(trigger_date, "%Y%m%d")
        next_idx = None
        for j in range(len(df_range)):
            if df_range.iloc[j]["date"] == trigger_dt:
                next_idx = j + 1
                break
        if next_idx is None or next_idx >= len(df_range):
            no_min_data += 1
            continue

        next_date = df_range.iloc[next_idx]["date"].strftime("%Y%m%d")
        next_open = float(df_range.iloc[next_idx]["open"])

        if idx % 10 == 0 and idx > 0:
            sys.stderr.write(f"  进度: {idx}/{len(trigger_days)}...\n")

        # 获取次日分钟数据
        df_min = fetch_min_data(code, next_date, time_start, query_end_time)
        if df_min is None or df_min.empty:
            no_min_data += 1
            continue

        bar_start = df_min[df_min["时间"].astype(str).str.contains(bar_start_time)]
        bar_end = df_min[df_min["时间"].astype(str).str.contains(bar_end_time)]

        if bar_start.empty or bar_end.empty:
            no_bar += 1
            continue

        price_start = float(bar_start.iloc[0]["开盘"])
        price_end = float(bar_end.iloc[0]["收盘"])
        diff = round(price_end - price_start, 3)
        total += diff

        details.append({
            "trigger_date": trigger_date,
            "next_date": next_date,
            "turnover": t["turnover"],
            "close": t["close"],
            "next_open": next_open,
            "price_start": price_start,
            "price_end": price_end,
            "diff": diff,
        })

    sys.stderr.write(
        f"结果: 有效 {len(details)} 次, 无分钟数据 {no_min_data} 次, 缺bar {no_bar} 次\n"
    )

    if len(details) == 0:
        return None

    max_pos = max(details, key=lambda x: x["diff"])
    max_neg = min(details, key=lambda x: x["diff"])
    pos_count = sum(1 for d in details if d["diff"] > 0)
    neg_count = sum(1 for d in details if d["diff"] < 0)

    first_close = float(df_range.iloc[0]["close"])
    last_close = float(df_range.iloc[-1]["close"])
    price_change = round(last_close - first_close, 3)

    return {
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
        "no_min_data": no_min_data,
        "no_bar": no_bar,
        "total": round(total, 3),
        "first_close": first_close,
        "last_close": last_close,
        "price_change": price_change,
        "positive_count": pos_count,
        "negative_count": neg_count,
        "zero_count": len(details) - pos_count - neg_count,
        "max_positive": {"trigger_date": max_pos["trigger_date"], "next_date": max_pos["next_date"],
                         "turnover": max_pos["turnover"], "diff": max_pos["diff"]},
        "max_negative": {"trigger_date": max_neg["trigger_date"], "next_date": max_neg["next_date"],
                         "turnover": max_neg["turnover"], "diff": max_neg["diff"]},
        "details": details,
    }


def main():
    parser = argparse.ArgumentParser(description="高换手率次日分时差值计算")
    parser.add_argument("--code", type=str, required=True, help="可转债代码")
    parser.add_argument("--from", dest="from_date", type=str, required=True)
    parser.add_argument("--to", dest="to_date", type=str, required=True)
    parser.add_argument("--time-start", type=str, default="09:30")
    parser.add_argument("--time-end", type=str, default="09:40")
    parser.add_argument("--turnover", type=float, default=100.0,
                        help="换手率阈值（%，默认100）")
    args = parser.parse_args()

    result = get_time_diff_with_turnover(
        args.code, args.from_date, args.to_date,
        args.time_start, args.time_end, args.turnover
    )

    if result is None:
        print(json.dumps({"error": "无有效数据（可能所有触发日均无分钟数据）"}, ensure_ascii=False))
        sys.exit(0)

    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
