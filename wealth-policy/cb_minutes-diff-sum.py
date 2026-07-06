# -*- coding: utf-8 -*-
"""
可转债分时差值计算（动态时间段）
规则: 每天 time_end价格 - time_start价格，输出所有差值的总和
数据: stock_zh_a_hist_min_em (东方财富5分钟K线)
  time_start ≈ 对应5分钟K线的开盘价
  time_end   ≈ 对应5分钟K线的收盘价
用法:
  python cb_ten_min_sum.py --code 127080 --from 20260701 --to 20260703 --time-start 09:30 --time-end 09:40
  python cb_ten_min_sum.py --code 127080 --from 20260701 --to 20260703 --time-start 10:30 --time-end 13:10
"""
import sys
import json
import argparse
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


def get_time_diff(code, from_date, to_date, time_start="09:30", time_end="09:40"):
    """
    计算每天 time_end 价格 - time_start 价格的差值并求和

    5分钟K线bar标签表示区间结束时间（如09:35 bar覆盖09:30-09:35）：
      - 开盘价 ≈ 区间起始价格
      - 收盘价 ≈ 区间结束价格
    time_start: HH:MM，用 (time_start+5min) bar的"开盘" = 该时刻价格
    time_end:   HH:MM，用 time_end bar的"收盘" = 该时刻价格
    """
    prefix = "sh" if code.startswith("11") else "sz"
    symbol_full = f"{prefix}{code}"

    # bar对齐: start时间用下一个5分钟bar的开盘价
    bar_start_time = add_minutes(time_start, 5)
    bar_end_time = time_end

    sys.stderr.write(
        f"查询: {code} {from_date} ~ {to_date} | 时段: {time_start} -> {time_end}"
        f" | bar: {bar_start_time}(开) -> {bar_end_time}(收)\n"
    )

    # 先获取日线确定交易日
    df_daily = ak.bond_zh_hs_cov_daily(symbol=symbol_full)
    if df_daily.empty:
        sys.stderr.write("日线数据为空\n")
        return None

    df_daily["date"] = pd.to_datetime(df_daily["date"])
    from_fmt = datetime.strptime(from_date, "%Y%m%d")
    to_fmt = datetime.strptime(to_date, "%Y%m%d")
    mask = (df_daily["date"] >= from_fmt) & (df_daily["date"] <= to_fmt)
    trading_days = df_daily[mask]["date"].dt.strftime("%Y%m%d").tolist()

    sys.stderr.write(f"区间交易日: {len(trading_days)} 天\n")

    # API查询范围：覆盖 bar_start_time 到 bar_end_time + 5分钟缓冲
    query_end_time = add_minutes(bar_end_time, 5)

    total = 0.0
    details = []
    empty_days = 0
    no_bar_days = 0

    for idx, day in enumerate(trading_days):
        if idx % 30 == 0:
            sys.stderr.write(f"  进度: {idx}/{len(trading_days)}...\n")

        try:
            df_min = ak.stock_zh_a_hist_min_em(
                symbol=code, period="5",
                start_date=f"{day} {time_start}:00",
                end_date=f"{day} {query_end_time}:00",
                adjust=""
            )
        except Exception as e:
            sys.stderr.write(f"  {day}: 接口异常 {str(e)[:60]}\n")
            continue

        if df_min.empty:
            empty_days += 1
            continue

        # bar_start_time bar的开盘价 = time_start时刻的近似价格
        # bar_end_time   bar的收盘价 = time_end时刻的近似价格
        bar_start = df_min[df_min["时间"].astype(str).str.contains(bar_start_time)]
        bar_end = df_min[df_min["时间"].astype(str).str.contains(bar_end_time)]

        if bar_start.empty or bar_end.empty:
            no_bar_days += 1
            continue

        price_start = float(bar_start.iloc[0]["开盘"])
        price_end = float(bar_end.iloc[0]["收盘"])
        diff = round(price_end - price_start, 3)
        total += diff

        details.append({
            "date": day,
            "price_start": price_start,
            "price_end": price_end,
            "diff": diff,
        })

    sys.stderr.write(
        f"  有效: {len(details)} 天, 无分钟数据: {empty_days} 天, "
        f"缺少目标bar: {no_bar_days} 天\n"
    )

    if len(details) == 0:
        return None

    max_pos = max(details, key=lambda x: x["diff"])
    max_neg = min(details, key=lambda x: x["diff"])
    pos_count = sum(1 for d in details if d["diff"] > 0)
    neg_count = sum(1 for d in details if d["diff"] < 0)

    return {
        "code": code,
        "time_start": time_start,
        "time_end": time_end,
        "from_date": from_date,
        "to_date": to_date,
        "total_trading_days": len(trading_days),
        "valid_days": len(details),
        "empty_days": empty_days,
        "no_bar_days": no_bar_days,
        "total": round(total, 3),
        "positive_count": pos_count,
        "negative_count": neg_count,
        "zero_count": len(details) - pos_count - neg_count,
        "max_positive": {"date": max_pos["date"], "diff": max_pos["diff"]},
        "max_negative": {"date": max_neg["date"], "diff": max_neg["diff"]},
        "details": details,
    }


def main():
    parser = argparse.ArgumentParser(description="可转债分时差值计算")
    parser.add_argument("--code", type=str, required=True, help="可转债代码")
    parser.add_argument("--from", dest="from_date", type=str, required=True)
    parser.add_argument("--to", dest="to_date", type=str, required=True)
    parser.add_argument("--time-start", type=str, default="09:30",
                        help="起始时间 HH:MM (默认 09:30)")
    parser.add_argument("--time-end", type=str, default="09:40",
                        help="结束时间 HH:MM (默认 09:40)")
    args = parser.parse_args()

    result = get_time_diff(
        args.code, args.from_date, args.to_date,
        args.time_start, args.time_end
    )

    if result is None:
        print(json.dumps({"error": "无有效数据"}, ensure_ascii=False))
        sys.exit(1)

    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
