# -*- coding: utf-8 -*-
"""
可转债隔夜跳空差值计算（次日9:40版）
计算规则: sum(次日9:40价格 - 当日收盘价)
数据源: akshare → bond_zh_hs_cov_daily + stock_zh_a_minute (5分钟K线)
用法: python cb_days-diff-sum-ex.py --names 127080,123225 --from 20260101 --to 20260703
输出: JSON 格式结果
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


def calc_diff_sum_0940(code, from_date, to_date):
    """
    计算 sum(次日9:40价格 - 当日收盘价)
    code: 可转债代码（如 "127080"）
    """
    prefix = "sh" if code.startswith("11") else "sz"
    symbol_full = f"{prefix}{code}"

    sys.stderr.write(f"查询: {code} {from_date} ~ {to_date}\n")

    # 1. 获取历史日线
    try:
        df = ak.bond_zh_hs_cov_daily(symbol=symbol_full)
    except Exception as e:
        sys.stderr.write(f"日线数据异常({code}): {e}\n")
        return None

    if df.empty or "date" not in df.columns:
        sys.stderr.write(f"日线数据为空或缺少日期列({code})\n")
        return None

    df["date"] = pd.to_datetime(df["date"])
    from_fmt = datetime.strptime(from_date, "%Y%m%d")
    to_fmt = datetime.strptime(to_date, "%Y%m%d")
    mask = (df["date"] >= from_fmt) & (df["date"] <= to_fmt)
    df_range = df[mask].sort_values("date").reset_index(drop=True)

    if len(df_range) < 2:
        sys.stderr.write(f"区间内交易日不足2天（共 {len(df_range)} 天）\n")
        return None

    # 2. 获取5分钟K线数据（新浪接口，无频率限制）
    sys.stderr.write("获取5分钟K线数据（新浪）...\n")
    try:
        df_min = ak.stock_zh_a_minute(symbol=symbol_full, period="5")
    except Exception as e:
        sys.stderr.write(f"分钟数据获取失败: {e}\n")
        return None

    if df_min.empty or "day" not in df_min.columns:
        sys.stderr.write("分钟数据为空\n")
        return None

    df_min["day"] = pd.to_datetime(df_min["day"])
    df_min["date_str"] = df_min["day"].dt.strftime("%Y%m%d")
    df_min["time_str"] = df_min["day"].dt.strftime("%H:%M")

    # 构建 日期 → 09:40收盘价 的映射（09:40 bar 的 close 就是9:40价格）
    # 注意: 5分钟bar的标签时间是区间结束时间，09:40 bar 覆盖 09:35-09:40
    df_0940 = df_min[df_min["time_str"] == "09:40"]
    price_0940_map = {}
    for _, row in df_0940.iterrows():
        price_0940_map[row["date_str"]] = float(row["close"])

    sys.stderr.write(
        f"分钟数据范围: {df_min['date_str'].min()} ~ {df_min['date_str'].max()}, "
        f"09:40数据: {len(price_0940_map)} 天\n"
    )

    # 3. 计算差值: 次日9:40价格 - 当日收盘价
    total = 0.0
    pct_total = 0.0
    details = []
    pos_count = 0
    neg_count = 0
    pct_pos_count = 0
    pct_neg_count = 0
    skipped_no_0940 = 0

    for i in range(len(df_range) - 1):
        close_curr = float(df_range.iloc[i]["close"])
        curr_date_str = df_range.iloc[i]["date"].strftime("%Y%m%d")
        next_date_str = df_range.iloc[i + 1]["date"].strftime("%Y%m%d")

        # 获取次日9:40价格
        next_0940 = price_0940_map.get(next_date_str)
        if next_0940 is None:
            skipped_no_0940 += 1
            details.append({
                "date": df_range.iloc[i]["date"].strftime("%Y-%m-%d"),
                "next_date": df_range.iloc[i + 1]["date"].strftime("%Y-%m-%d"),
                "close": close_curr,
                "next_0940": None,
                "diff": 0,
                "pct_diff": 0,
            })
            continue

        diff = round(next_0940 - close_curr, 3)
        total += diff

        if diff > 0:
            pos_count += 1
        elif diff < 0:
            neg_count += 1

        # 百分比差值
        if close_curr > 0:
            pct_diff = round(diff / close_curr * 100, 3)
        else:
            pct_diff = 0.0
        pct_total += pct_diff

        if pct_diff > 0:
            pct_pos_count += 1
        elif pct_diff < 0:
            pct_neg_count += 1

        details.append({
            "date": df_range.iloc[i]["date"].strftime("%Y-%m-%d"),
            "next_date": df_range.iloc[i + 1]["date"].strftime("%Y-%m-%d"),
            "close": close_curr,
            "next_0940": next_0940,
            "diff": diff,
            "pct_diff": pct_diff,
        })

    sys.stderr.write(f"跳过(缺09:40): {skipped_no_0940} 天\n")

    # 有效配对（排除跳过的）
    valid_details = [d for d in details if d.get("next_0940") is not None]
    valid_pairs = len(valid_details)

    if valid_pairs == 0:
        sys.stderr.write("无有效配对\n")
        return None

    # 找最大正差和最大负差（仅有效配对）
    max_pos = max(valid_details, key=lambda x: x["diff"])
    max_neg = min(valid_details, key=lambda x: x["diff"])
    max_pct_pos = max(valid_details, key=lambda x: x["pct_diff"])
    max_pct_neg = min(valid_details, key=lambda x: x["pct_diff"])

    first_close = float(df_range.iloc[0]["close"])
    last_close = float(df_range.iloc[-1]["close"])
    price_change = round(last_close - first_close, 3)

    zero_count = valid_pairs - pos_count - neg_count
    pct_zero_count = valid_pairs - pct_pos_count - pct_neg_count

    return {
        "code": code,
        "from_date": from_date,
        "to_date": to_date,
        "trading_days": len(df_range),
        "pairs": len(details),          # 总配对数（含跳过的）
        "valid_pairs": valid_pairs,     # 有效配对数
        "skipped_no_0940": skipped_no_0940,
        "total": round(total, 3),
        "pct_total": round(pct_total, 3),
        "first_close": first_close,
        "last_close": last_close,
        "price_change": price_change,
        "max_positive": {"date": max_pos["date"], "next_date": max_pos["next_date"], "diff": max_pos["diff"]},
        "max_negative": {"date": max_neg["date"], "next_date": max_neg["next_date"], "diff": max_neg["diff"]},
        "max_pct_positive": {"date": max_pct_pos["date"], "pct_diff": max_pct_pos["pct_diff"]},
        "max_pct_negative": {"date": max_pct_neg["date"], "pct_diff": max_pct_neg["pct_diff"]},
        "positive_count": pos_count,
        "negative_count": neg_count,
        "zero_count": zero_count,
        "pct_positive_count": pct_pos_count,
        "pct_negative_count": pct_neg_count,
        "pct_zero_count": pct_zero_count,
        "details": details,
    }


def main():
    parser = argparse.ArgumentParser(description="可转债隔夜跳空差值计算（次日9:40版）")
    parser.add_argument("--names", type=str, default="", help="可转债代码（逗号分隔）")
    parser.add_argument("--from", dest="from_date", type=str, required=True, help="起始日期 YYYYMMDD")
    parser.add_argument("--to", dest="to_date", type=str, required=True, help="结束日期 YYYYMMDD")
    args = parser.parse_args()

    all_codes = [c.strip() for c in args.names.split(",") if c.strip()]

    if not all_codes:
        print(json.dumps({"error": "请指定 --names"}, ensure_ascii=False))
        sys.exit(1)

    # 去重
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
            result = calc_diff_sum_0940(code, args.from_date, args.to_date)
        except Exception as e:
            sys.stderr.write(f"处理异常({code}): {e}\n")
            result = None
        if result is None:
            results.append({"code": code, "error": "无有效数据"})
        else:
            results.append(result)

    if len(results) == 1:
        print(json.dumps(results[0], ensure_ascii=False))
    else:
        print(json.dumps(results, ensure_ascii=False))
    sys.stdout.flush()
    sys.stderr.write(f"完成 {len(results)} 条结果，有效 {sum(1 for r in results if 'error' not in r)} 条\n")
    sys.stderr.flush()
    os._exit(0)  # 立即退出，避免 akshare 的后台线程/atexit 导致进程卡死


if __name__ == "__main__":
    main()
