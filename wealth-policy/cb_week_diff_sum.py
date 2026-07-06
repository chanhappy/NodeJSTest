# -*- coding: utf-8 -*-
"""
可转债周间跳空差值计算
规则: 周一开盘价 - 上周五收盘价，输出差值总和
用法: python cb_week_diff_sum.py --code 127080 --from 20260101 --to 20260703
"""
import sys
import json
import argparse
from datetime import datetime
import akshare as ak
import pandas as pd


def calc_week_diff_sum(code, from_date, to_date):
    """
    计算 sum(周一开盘 - 上周五收盘)
    """
    prefix = "sh" if code.startswith("11") else "sz"
    symbol_full = f"{prefix}{code}"

    sys.stderr.write(f"查询: {code} {from_date} ~ {to_date}\n")

    # 获取日线
    df = ak.bond_zh_hs_cov_daily(symbol=symbol_full)
    if df.empty:
        sys.stderr.write("日线数据为空\n")
        return None

    df["date"] = pd.to_datetime(df["date"])
    from_fmt = datetime.strptime(from_date, "%Y%m%d")
    to_fmt = datetime.strptime(to_date, "%Y%m%d")
    mask = (df["date"] >= from_fmt) & (df["date"] <= to_fmt)
    df_range = df[mask].sort_values("date").reset_index(drop=True)

    if len(df_range) == 0:
        sys.stderr.write("区间内无交易日\n")
        return None

    # 添加星期几列 (0=Monday, 4=Friday)
    df_range["weekday"] = df_range["date"].dt.dayofweek

    total = 0.0
    details = []
    pos_count = 0
    neg_count = 0
    monday_count = 0
    skipped = 0

    for i in range(len(df_range)):
        if df_range.iloc[i]["weekday"] != 0:
            continue

        monday_count += 1
        monday_row = df_range.iloc[i]
        monday_open = float(monday_row["open"])
        monday_date = monday_row["date"]

        # 向前查找最近的周五
        found = False
        for j in range(i - 1, max(i - 10, -1), -1):
            if df_range.iloc[j]["weekday"] == 4:
                friday_row = df_range.iloc[j]
                friday_close = float(friday_row["close"])
                friday_date = friday_row["date"]

                # 确保是前一周的周五（非本周五）
                day_diff = (monday_date - friday_date).days
                if day_diff > 7:
                    # 中间有长假，跳过
                    found = True
                    skipped += 1
                    break

                diff = round(monday_open - friday_close, 3)
                total += diff

                if diff > 0:
                    pos_count += 1
                elif diff < 0:
                    neg_count += 1

                details.append({
                    "friday_date": friday_date.strftime("%Y-%m-%d"),
                    "monday_date": monday_date.strftime("%Y-%m-%d"),
                    "friday_close": friday_close,
                    "monday_open": monday_open,
                    "diff": diff,
                })
                found = True
                break

        if not found:
            skipped += 1

    sys.stderr.write(
        f"  周一总数: {monday_count} | 匹配到上周五: {len(details)} | 跳过: {skipped}\n"
    )

    if len(details) == 0:
        return None

    max_pos = max(details, key=lambda x: x["diff"])
    max_neg = min(details, key=lambda x: x["diff"])

    return {
        "code": code,
        "from_date": from_date,
        "to_date": to_date,
        "total_trading_days": len(df_range),
        "monday_count": monday_count,
        "valid_pairs": len(details),
        "skipped": skipped,
        "total": round(total, 3),
        "positive_count": pos_count,
        "negative_count": neg_count,
        "zero_count": len(details) - pos_count - neg_count,
        "max_positive": {
            "friday": max_pos["friday_date"],
            "monday": max_pos["monday_date"],
            "diff": max_pos["diff"],
        },
        "max_negative": {
            "friday": max_neg["friday_date"],
            "monday": max_neg["monday_date"],
            "diff": max_neg["diff"],
        },
        "details": details,
    }


def main():
    parser = argparse.ArgumentParser(description="可转债周间跳空差值计算")
    parser.add_argument("--code", type=str, required=True, help="可转债代码")
    parser.add_argument("--from", dest="from_date", type=str, required=True)
    parser.add_argument("--to", dest="to_date", type=str, required=True)
    args = parser.parse_args()

    result = calc_week_diff_sum(args.code, args.from_date, args.to_date)

    if result is None:
        print(json.dumps({"error": "无有效数据"}, ensure_ascii=False))
        sys.exit(1)

    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
