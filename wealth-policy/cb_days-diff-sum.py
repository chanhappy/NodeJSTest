# -*- coding: utf-8 -*-
"""
可转债隔夜跳空差值计算
计算规则: sum(次日开盘价 - 当日收盘价)
用法: python cb_diff_sum.py --name 声迅转债 --from 20260101 --to 20260703
输出: JSON 格式结果
"""
import sys
import json
import argparse
from datetime import datetime
import akshare as ak
import pandas as pd


def find_code_by_name(name):
    """根据名称搜索可转债代码"""
    spot = ak.bond_zh_hs_cov_spot()
    spot = spot[~spot["symbol"].str.startswith("bj")]
    matches = spot[spot["name"].str.contains(name, na=False)]
    if len(matches) == 0:
        return None, None
    row = matches.iloc[0]
    symbol = str(row["symbol"])
    code = symbol[2:] if len(symbol) > 2 else symbol
    cname = str(row["name"])
    return code, cname


def calc_diff_sum(name_or_code, from_date, to_date):
    """
    计算可转债隔夜跳空差值总和
    name_or_code: 名称或代码（如 "声迅转债" 或 "127080"）
    from_date: YYYYMMDD
    to_date: YYYYMMDD
    """
    # 判断是名称还是代码
    if name_or_code.isdigit():
        code = name_or_code
        # 获取名称
        spot = ak.bond_zh_hs_cov_spot()
        spot = spot[~spot["symbol"].str.startswith("bj")]
        for _, row in spot.iterrows():
            sym = str(row["symbol"])
            c = sym[2:] if len(sym) > 2 else sym
            if c == code:
                name = str(row["name"])
                break
        else:
            name = code
    else:
        code, name = find_code_by_name(name_or_code)
        if code is None:
            sys.stderr.write(f"未找到匹配的可转债: {name_or_code}\n")
            return None

    # 构建 symbol
    prefix = "sh" if code.startswith("11") else "sz"
    symbol_full = f"{prefix}{code}"

    sys.stderr.write(f"查询: {name}({code}) {from_date} ~ {to_date}\n")

    # 获取历史日线
    df = ak.bond_zh_hs_cov_daily(symbol=symbol_full)
    if df.empty:
        sys.stderr.write("未获取到数据\n")
        return None

    df["date"] = pd.to_datetime(df["date"])

    # 格式化日期范围
    from_fmt = datetime.strptime(from_date, "%Y%m%d")
    to_fmt = datetime.strptime(to_date, "%Y%m%d")

    mask = (df["date"] >= from_fmt) & (df["date"] <= to_fmt)
    df_range = df[mask].sort_values("date").reset_index(drop=True)

    if len(df_range) < 2:
        sys.stderr.write(f"区间内交易日不足2天（共 {len(df_range)} 天）\n")
        return None

    # 计算差值
    total = 0.0
    details = []
    pos_count = 0
    neg_count = 0

    for i in range(len(df_range) - 1):
        open_next = float(df_range.iloc[i + 1]["open"])
        close_curr = float(df_range.iloc[i]["close"])
        diff = round(open_next - close_curr, 3)
        total += diff

        if diff > 0:
            pos_count += 1
        elif diff < 0:
            neg_count += 1

        details.append({
            "date": df_range.iloc[i]["date"].strftime("%Y-%m-%d"),
            "next_date": df_range.iloc[i + 1]["date"].strftime("%Y-%m-%d"),
            "close": close_curr,
            "next_open": open_next,
            "diff": diff,
        })

    # 找最大正差和最大负差
    max_pos = max(details, key=lambda x: x["diff"])
    max_neg = min(details, key=lambda x: x["diff"])

    # 数据范围内的首尾价格
    first_close = float(df_range.iloc[0]["close"])
    last_close = float(df_range.iloc[-1]["close"])
    price_change = round(last_close - first_close, 3)

    return {
        "code": code,
        "name": name,
        "from_date": from_date,
        "to_date": to_date,
        "trading_days": len(df_range),
        "pairs": len(details),
        "total": round(total, 3),
        "first_close": first_close,
        "last_close": last_close,
        "price_change": price_change,
        "max_positive": {"date": max_pos["date"], "next_date": max_pos["next_date"], "diff": max_pos["diff"]},
        "max_negative": {"date": max_neg["date"], "next_date": max_neg["next_date"], "diff": max_neg["diff"]},
        "positive_count": pos_count,
        "negative_count": neg_count,
        "details": details,
    }


def main():
    parser = argparse.ArgumentParser(description="可转债隔夜跳空差值计算")
    parser.add_argument("--name", type=str, required=True, help="可转债名称或代码")
    parser.add_argument("--from", dest="from_date", type=str, required=True, help="起始日期 YYYYMMDD")
    parser.add_argument("--to", dest="to_date", type=str, required=True, help="结束日期 YYYYMMDD")
    args = parser.parse_args()

    result = calc_diff_sum(args.name, args.from_date, args.to_date)

    if result is None:
        print(json.dumps({"error": "计算失败"}, ensure_ascii=False))
        sys.exit(1)

    # 输出 JSON（details 太大，单独控制是否输出）
    output = {k: v for k, v in result.items() if k != "details"}
    output["details"] = result["details"]
    print(json.dumps(output, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
