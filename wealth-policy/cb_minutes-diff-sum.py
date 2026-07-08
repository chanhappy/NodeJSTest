# -*- coding: utf-8 -*-
"""
可转债分时差值计算（动态时间段）
规则: 每天 time_end价格 - time_start价格，输出所有差值的总和
数据: stock_zh_a_minute (新浪5分钟K线，一次调用获取全量数据，避免东方财富限流)
  time_start ≈ 对应5分钟K线的开盘价
  time_end   ≈ 对应5分钟K线的收盘价
用法:
  python cb_minutes-diff-sum.py --code 127080 --from 20260701 --to 20260703 --time-start 09:30 --time-end 09:40
  python cb_minutes-diff-sum.py --code 127080 --from 20260701 --to 20260703 --time-start 10:30 --time-end 13:10
"""
import sys
import json
import argparse
import socket
import os
from datetime import datetime
import akshare as ak
import pandas as pd

# 防止网络请求挂死：全局 socket 超时 30 秒
socket.setdefaulttimeout(30)


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

    # 1. 获取日线确定交易日
    try:
        df_daily = ak.bond_zh_hs_cov_daily(symbol=symbol_full)
    except Exception as e:
        sys.stderr.write(f"日线数据异常({code}): {e}\n")
        return None

    if df_daily.empty or "date" not in df_daily.columns:
        sys.stderr.write(f"日线数据为空或缺少日期列({code})\n")
        return None

    df_daily["date"] = pd.to_datetime(df_daily["date"])
    from_fmt = datetime.strptime(from_date, "%Y%m%d")
    to_fmt = datetime.strptime(to_date, "%Y%m%d")
    mask = (df_daily["date"] >= from_fmt) & (df_daily["date"] <= to_fmt)
    trading_days = df_daily[mask]["date"].dt.strftime("%Y%m%d").tolist()

    sys.stderr.write(f"区间交易日: {len(trading_days)} 天\n")

    # 2. 一次性获取所有可用的5分钟K线数据（新浪接口，无频率限制）
    sys.stderr.write("获取5分钟K线数据（新浪）...\n")
    try:
        df_min = ak.stock_zh_a_minute(symbol=symbol_full, period="5")
    except Exception as e:
        sys.stderr.write(f"分钟数据获取失败: {e}\n")
        return None

    if df_min.empty:
        sys.stderr.write("分钟数据为空\n")
        return None

    # 新浪的 day 字段是 datetime，格式如 "2026-05-07 09:35:00"
    # 提取日期和时间部分
    df_min["day"] = pd.to_datetime(df_min["day"])
    df_min["date_str"] = df_min["day"].dt.strftime("%Y%m%d")
    df_min["time_str"] = df_min["day"].dt.strftime("%H:%M")

    data_start = df_min["date_str"].min()
    data_end = df_min["date_str"].max()
    sys.stderr.write(f"分钟数据范围: {data_start} ~ {data_end} ({len(df_min)} 条)\n")

    # 筛选目标交易日
    target_days_set = set(trading_days)
    df_min_range = df_min[df_min["date_str"].isin(target_days_set)].copy()

    sys.stderr.write(f"区间内匹配的分钟数据: {len(df_min_range)} 条\n")

    if df_min_range.empty:
        sys.stderr.write("区间内无分钟数据（可能日期超出新浪覆盖范围）\n")
        return None

    # 3. 构建日线数据映射（用于获取每日开盘价）
    daily_open_map = {}
    for _, row in df_daily.iterrows():
        d_key = row["date"].strftime("%Y%m%d")
        daily_open_map[d_key] = float(row["open"])

    # 4. 按日期分组，找到每天的 bar_start_time 和 bar_end_time
    total = 0.0
    pct_total = 0.0
    details = []
    no_bar_days = set()
    empty_days = set()

    for day in trading_days:
        day_data = df_min_range[df_min_range["date_str"] == day]
        if day_data.empty:
            empty_days.add(day)
            continue

        bar_start = day_data[day_data["time_str"] == bar_start_time]
        bar_end = day_data[day_data["time_str"] == bar_end_time]

        if bar_start.empty or bar_end.empty:
            no_bar_days.add(day)
            continue

        price_start = float(bar_start.iloc[0]["open"])
        price_end = float(bar_end.iloc[0]["close"])
        diff = round(price_end - price_start, 3)
        total += diff

        # 百分比差值（基于当日开盘价）
        day_open = daily_open_map.get(day)
        if day_open and day_open > 0:
            pct_start = round((price_start - day_open) / day_open * 100, 3)
            pct_end = round((price_end - day_open) / day_open * 100, 3)
            pct_diff = round(pct_end - pct_start, 3)
        else:
            pct_start = 0.0
            pct_end = 0.0
            pct_diff = 0.0

        pct_total += pct_diff

        details.append({
            "date": day,
            "price_start": price_start,
            "price_end": price_end,
            "diff": diff,
            "pct_diff": pct_diff,
        })

    sys.stderr.write(
        f"  有效: {len(details)} 天, 无分钟数据: {len(empty_days)} 天, "
        f"缺少目标bar: {len(no_bar_days)} 天\n"
    )
    if empty_days:
        out_of_range = [d for d in sorted(empty_days) if d < data_start or d > data_end]
        if out_of_range:
            sys.stderr.write(f"  超出新浪覆盖范围的日期: {out_of_range[0]} ~ {out_of_range[-1]} ({len(out_of_range)}天)\n")

    if len(details) == 0:
        return None

    max_pos = max(details, key=lambda x: x["diff"])
    max_neg = min(details, key=lambda x: x["diff"])
    max_pct_pos = max(details, key=lambda x: x["pct_diff"])
    max_pct_neg = min(details, key=lambda x: x["pct_diff"])
    pos_count = sum(1 for d in details if d["diff"] > 0)
    neg_count = sum(1 for d in details if d["diff"] < 0)
    pct_pos_count = sum(1 for d in details if d["pct_diff"] > 0)
    pct_neg_count = sum(1 for d in details if d["pct_diff"] < 0)

    return {
        "code": code,
        "time_start": time_start,
        "time_end": time_end,
        "from_date": from_date,
        "to_date": to_date,
        "total_trading_days": len(trading_days),
        "valid_days": len(details),
        "empty_days": len(empty_days),
        "no_bar_days": len(no_bar_days),
        "total": round(total, 3),
        "pct_total": round(pct_total, 3),
        "positive_count": pos_count,
        "negative_count": neg_count,
        "zero_count": len(details) - pos_count - neg_count,
        "pct_positive_count": pct_pos_count,
        "pct_negative_count": pct_neg_count,
        "pct_zero_count": len(details) - pct_pos_count - pct_neg_count,
        "max_positive": {"date": max_pos["date"], "diff": max_pos["diff"]},
        "max_negative": {"date": max_neg["date"], "diff": max_neg["diff"]},
        "max_pct_positive": {"date": max_pct_pos["date"], "pct_diff": max_pct_pos["pct_diff"]},
        "max_pct_negative": {"date": max_pct_neg["date"], "pct_diff": max_pct_neg["pct_diff"]},
        "details": details,
    }


def main():
    parser = argparse.ArgumentParser(description="可转债分时差值计算")
    parser.add_argument("--code", type=str, default="", help="可转债代码（单个）")
    parser.add_argument("--codes", type=str, default="", help="可转债代码（逗号分隔，多个）")
    parser.add_argument("--from", dest="from_date", type=str, required=True)
    parser.add_argument("--to", dest="to_date", type=str, required=True)
    parser.add_argument("--time-start", type=str, default="09:30",
                        help="起始时间 HH:MM (默认 09:30)")
    parser.add_argument("--time-end", type=str, default="09:40",
                        help="结束时间 HH:MM (默认 09:40)")
    args = parser.parse_args()

    # 合并 --code 和 --codes
    all_codes = []
    if args.codes:
        all_codes.extend([c.strip() for c in args.codes.split(",") if c.strip()])
    if args.code:
        all_codes.append(args.code.strip())

    if not all_codes:
        print(json.dumps({"error": "请指定 --code 或 --codes"}, ensure_ascii=False))
        sys.exit(1)

    # 去重保持顺序
    seen = set()
    codes = []
    for c in all_codes:
        if c not in seen:
            seen.add(c)
            codes.append(c)

    results = []
    for i, code in enumerate(codes):
        if len(codes) > 1:
            sys.stderr.write(f"\n[{i+1}/{len(codes)}] ")
        try:
            result = get_time_diff(
                code, args.from_date, args.to_date,
                args.time_start, args.time_end
            )
        except Exception as e:
            sys.stderr.write(f"处理异常({code}): {e}\n")
            result = None
        if result is None:
            results.append({"code": code, "error": "无有效数据"})
        else:
            results.append(result)

    print(json.dumps(results, ensure_ascii=False))
    sys.stdout.flush()
    sys.stderr.write(f"完成 {len(results)} 条结果，有效 {sum(1 for r in results if 'error' not in r)} 条\n")
    sys.stderr.flush()
    os._exit(0)  # 立即退出，避免 akshare 的后台线程/atexit 导致进程卡死


if __name__ == "__main__":
    main()
