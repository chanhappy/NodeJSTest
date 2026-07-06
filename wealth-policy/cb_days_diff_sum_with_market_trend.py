# -*- coding: utf-8 -*-
"""
大盘大跌后次日跳空差值计算
计算规则: 当A股大盘（上证指数）单日跌超1%时，sum(次日开盘价 - 当日收盘价)
用法: python cb_days_diff_sum_with_market_trend.py --name 声迅转债 --from 20260101 --to 20260703
输出: JSON 格式结果
"""
import sys
import json
import argparse
from datetime import datetime
import akshare as ak
import pandas as pd


# ==================== 参数 ====================
DROP_THRESHOLD = -1.0  # 大盘跌幅阈值（%），负值表示下跌


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


def get_index_pct_chg(from_date, to_date, threshold=DROP_THRESHOLD):
    """
    获取上证指数每日涨跌幅
    返回 dict: { "2026-01-02": -1.5, "2026-01-03": 0.3, ... }
    """
    sys.stderr.write("获取上证指数 (sh000001) 日线数据...\n")
    try:
        df = ak.stock_zh_index_daily(symbol="sh000001")
    except Exception as e:
        sys.stderr.write(f"上证指数获取失败: {e}\n")
        return {}

    if df.empty:
        sys.stderr.write("上证指数数据为空\n")
        return {}

    df["date"] = pd.to_datetime(df["date"])
    df = df.sort_values("date").reset_index(drop=True)

    from_fmt = datetime.strptime(from_date, "%Y%m%d")
    to_fmt = datetime.strptime(to_date, "%Y%m%d")

    # 截取日期范围，并向前多取1天（用于计算第一天涨跌幅）
    from_extended = df[df["date"] < from_fmt]["date"].max()
    if pd.isna(from_extended):
        mask = (df["date"] >= from_fmt) & (df["date"] <= to_fmt)
    else:
        mask = (df["date"] >= from_extended) & (df["date"] <= to_fmt)

    df_range = df[mask].reset_index(drop=True)

    if len(df_range) < 2:
        sys.stderr.write(f"上证指数区间内数据不足\n")
        return {}

    pct_map = {}
    for i in range(1, len(df_range)):
        prev_close = float(df_range.iloc[i - 1]["close"])
        curr_close = float(df_range.iloc[i]["close"])
        if prev_close > 0:
            pct = round((curr_close - prev_close) / prev_close * 100, 2)
            date_key = df_range.iloc[i]["date"].strftime("%Y-%m-%d")
            pct_map[date_key] = pct

    # 只返回用户指定范围内的数据
    from_fmt_key = from_fmt.strftime("%Y-%m-%d")
    to_fmt_key = to_fmt.strftime("%Y-%m-%d")
    filtered = {k: v for k, v in pct_map.items() if from_fmt_key <= k <= to_fmt_key}

    drop_days = sum(1 for v in filtered.values() if v <= threshold)
    sys.stderr.write(f"上证指数: {len(filtered)} 个交易日, 跌超{abs(threshold)}% 共 {drop_days} 天\n")
    return filtered


def calc_diff_sum(name_or_code, from_date, to_date, threshold=DROP_THRESHOLD):
    """
    计算大盘跌超阈值后，可转债次日跳空差值总和

    name_or_code: 名称或代码
    from_date: YYYYMMDD
    to_date: YYYYMMDD
    threshold: 大盘跌幅阈值（默认 -1.0 即跌超1%）
    """
    # 判断是名称还是代码
    if name_or_code.isdigit():
        code = name_or_code
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

    prefix = "sh" if code.startswith("11") else "sz"
    symbol_full = f"{prefix}{code}"

    sys.stderr.write(f"查询: {name}({code}) {from_date} ~ {to_date} | 大盘跌超{abs(threshold)}%\n")

    # 1. 获取可转债日线
    df = ak.bond_zh_hs_cov_daily(symbol=symbol_full)
    if df.empty:
        sys.stderr.write("未获取到数据\n")
        return None

    df["date"] = pd.to_datetime(df["date"])
    df = df.sort_values("date").reset_index(drop=True)

    from_fmt = datetime.strptime(from_date, "%Y%m%d")
    to_fmt = datetime.strptime(to_date, "%Y%m%d")

    mask = (df["date"] >= from_fmt) & (df["date"] <= to_fmt)
    df_range = df[mask].reset_index(drop=True)

    if len(df_range) < 2:
        sys.stderr.write(f"区间内交易日不足2天（共 {len(df_range)} 天）\n")
        return None

    # 构建日期→数据行的索引
    date_to_idx = {}
    for i in range(len(df_range)):
        dk = df_range.iloc[i]["date"].strftime("%Y-%m-%d")
        date_to_idx[dk] = i

    # 2. 获取大盘涨跌幅
    index_pct = get_index_pct_chg(from_date, to_date, threshold)

    # 3. 筛选大盘跌超阈值日，计算差值
    total = 0.0
    details = []
    skip_no_next = 0

    for date_key, pct in sorted(index_pct.items()):
        if pct > threshold:
            continue

        # 检查当日和次日是否有数据
        idx = date_to_idx.get(date_key)
        if idx is None:
            continue

        # 次日索引
        next_idx = idx + 1
        if next_idx >= len(df_range):
            skip_no_next += 1
            continue

        close_curr = float(df_range.iloc[idx]["close"])
        open_next = float(df_range.iloc[next_idx]["open"])
        diff = round(open_next - close_curr, 3)
        total += diff

        next_date = df_range.iloc[next_idx]["date"].strftime("%Y-%m-%d")

        details.append({
            "date": date_key,
            "next_date": next_date,
            "market_pct": pct,
            "close": close_curr,
            "next_open": open_next,
            "diff": diff,
        })

    # 统计
    pos_count = sum(1 for d in details if d["diff"] > 0)
    neg_count = sum(1 for d in details if d["diff"] < 0)

    first_close = float(df_range.iloc[0]["close"])
    last_close = float(df_range.iloc[-1]["close"])
    price_change = round(last_close - first_close, 3)

    # 最大正差/负差
    max_pos = max(details, key=lambda x: x["diff"]) if details else None
    max_neg = min(details, key=lambda x: x["diff"]) if details else None

    sys.stderr.write(
        f"结果: 触发 {len(details)} 次, 跳过(无次日) {skip_no_next} 次, "
        f"总和 {total:+.3f}, 正 {pos_count} 负 {neg_count}\n"
    )

    return {
        "code": code,
        "name": name,
        "from_date": from_date,
        "to_date": to_date,
        "threshold": threshold,
        "trading_days": len(df_range),
        "market_days": len(index_pct),
        "trigger_count": len(details),
        "total": round(total, 3),
        "first_close": first_close,
        "last_close": last_close,
        "price_change": price_change,
        "max_positive": {
            "date": max_pos["date"], "next_date": max_pos["next_date"],
            "market_pct": max_pos["market_pct"], "diff": max_pos["diff"],
        } if max_pos else None,
        "max_negative": {
            "date": max_neg["date"], "next_date": max_neg["next_date"],
            "market_pct": max_neg["market_pct"], "diff": max_neg["diff"],
        } if max_neg else None,
        "positive_count": pos_count,
        "negative_count": neg_count,
        "details": details,
    }


def main():
    parser = argparse.ArgumentParser(description="大盘跌超阈值后次日跳空差值计算")
    parser.add_argument("--name", type=str, required=True, help="可转债名称或代码")
    parser.add_argument("--from", dest="from_date", type=str, required=True, help="起始日期 YYYYMMDD")
    parser.add_argument("--to", dest="to_date", type=str, required=True, help="结束日期 YYYYMMDD")
    parser.add_argument("--threshold", type=float, default=DROP_THRESHOLD,
                        help=f"大盘跌幅阈值（默认 {DROP_THRESHOLD}，即跌超1%%）")
    args = parser.parse_args()

    result = calc_diff_sum(args.name, args.from_date, args.to_date, args.threshold)

    if result is None:
        print(json.dumps({"error": "计算失败"}, ensure_ascii=False))
        sys.exit(1)

    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
