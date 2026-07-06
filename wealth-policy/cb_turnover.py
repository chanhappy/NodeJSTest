# -*- coding: utf-8 -*-
"""
可转债换手率数据获取脚本（Node.js 桥接层）
数据源: akshare (集思录 + 新浪实时行情 + 历史日线)
用法: python cb_turnover.py [--top N] [--sort asc|desc] [--date YYYYMMDD]
输出: JSON 格式的可转债换手率数据

策略:
  方案A（优先）: bond_cb_jsl() - 集思录，直接含换手率，但未登录仅30条
  方案B（兜底）: bond_zh_hs_cov_spot() - 新浪实时行情320只，有成交量无换手率
                结合 bond_cb_jsl 的剩余规模计算换手率
  方案C（历史）: bond_zh_hs_cov_daily() - 新浪历史日线，按日期查询所有可转债
"""
import sys
import json
import argparse
from datetime import datetime
import akshare as ak
import pandas as pd


def get_by_jsl():
    """方案A: 集思录 - 直接含换手率"""
    sys.stderr.write("[方案A] 集思录 bond_cb_jsl...\n")
    df = ak.bond_cb_jsl()
    bonds = []
    for _, row in df.iterrows():
        def safe_float(val, default=0.0):
            try:
                v = float(val) if val else default
                return default if pd.isna(v) else v
            except (ValueError, TypeError):
                return default

        raw_turnover = safe_float(row.get("换手率", 0))
        bonds.append({
            "code": str(row.get("代码", "")),
            "name": str(row.get("转债名称", "")),
            "price": safe_float(row.get("现价", 0)),
            "pct": safe_float(row.get("涨跌幅", 0)),
            "turnover": round(raw_turnover / 10, 2),
            "volume": safe_float(row.get("成交额", 0)),
            "premium_rt": safe_float(row.get("转股溢价率", 0)),
            "curr_iss_amt": safe_float(row.get("剩余规模", 0)),
            "source": "jsl",
        })
    return bonds


def get_by_spot():
    """方案B: 新浪实时行情 - 有成交量，用剩余规模算换手率"""
    sys.stderr.write("[方案B] 新浪 bond_zh_hs_cov_spot + 集思录规模...\n")
    
    spot = ak.bond_zh_hs_cov_spot()
    spot = spot[~spot["symbol"].str.startswith("bj")]

    jsl = ak.bond_cb_jsl()
    scale_map = {}
    for _, row in jsl.iterrows():
        code = str(row.get("代码", ""))
        amt = float(row.get("剩余规模", 0) or 0)
        if code and amt > 0:
            scale_map[code] = amt

    def safe_float(val, default=0.0):
        try:
            v = float(val) if val else default
            return default if pd.isna(v) else v
        except (ValueError, TypeError):
            return default

    bonds = []
    matched = 0
    for _, row in spot.iterrows():
        symbol = str(row.get("symbol", ""))
        code = symbol[2:] if len(symbol) > 2 else symbol
        name = str(row.get("name", ""))
        price = safe_float(row.get("trade", 0))
        pct = safe_float(row.get("changepercent", 0))
        vol = safe_float(row.get("volume", 0))

        scale = scale_map.get(code, 0)
        if scale > 0 and vol > 0:
            turnover = vol / scale / 100000
            matched += 1
        else:
            turnover = 0

        bonds.append({
            "code": code,
            "name": name,
            "price": price,
            "pct": pct,
            "turnover": round(turnover, 2),
            "volume": vol,
            "curr_iss_amt": scale,
            "source": "spot",
        })

    sys.stderr.write(f"  行情: {len(bonds)} 只, 规模匹配: {matched} 只\n")
    return bonds


def get_by_date(date_str):
    """
    方案C: 获取指定日期的可转债换手率（串行查询）
    date_str: YYYYMMDD 格式，如 20260703
    """
    sys.stderr.write(f"[方案C] 获取 {date_str} 历史数据...\n")
    
    # 1. 获取所有可转债代码列表
    sys.stderr.write("  获取所有可转债代码列表...\n")
    try:
        spot = ak.bond_zh_hs_cov_spot()
        spot = spot[~spot["symbol"].str.startswith("bj")]
    except Exception as e:
        sys.stderr.write(f"  新浪行情获取失败: {e}\n")
        return []
    
    # 2. 获取规模数据
    sys.stderr.write("  获取规模数据...\n")
    scale_map = {}  # 剩余规模
    issue_scale_map = {}  # 发行规模（备用）
    
    try:
        jsl = ak.bond_cb_jsl()
        for _, row in jsl.iterrows():
            code = str(row.get("代码", ""))
            amt = float(row.get("剩余规模", 0) or 0)
            if code and amt > 0:
                scale_map[code] = amt
        sys.stderr.write(f"  集思录获取到 {len(scale_map)} 只债券的剩余规模\n")
    except Exception as e:
        sys.stderr.write(f"  集思录数据获取失败: {e}\n")
    
    try:
        info = ak.bond_zh_cov_info_ths()
        for _, row in info.iterrows():
            code = str(row.get("债券代码", ""))
            amt = float(row.get("实际发行量", 0) or 0)
            if code and amt > 0:
                issue_scale_map[code] = amt
        sys.stderr.write(f"  同花顺获取到 {len(issue_scale_map)} 只债券的发行规模\n")
    except Exception as e:
        sys.stderr.write(f"  同花顺数据获取失败: {e}\n")
    
    # 3. 串行查询每个债券的历史数据
    bonds = []
    total = len(spot)
    date_formatted = datetime.strptime(date_str, "%Y%m%d").strftime("%Y-%m-%d")
    
    sys.stderr.write(f"  开始查询 {total} 只债券的历史数据（串行模式）...\n")
    
    for idx, (_, row) in enumerate(spot.iterrows()):
        symbol = str(row.get("symbol", ""))
        code = symbol[2:] if len(symbol) > 2 else symbol
        name = str(row.get("name", ""))
        
        if not code:
            continue
        
        if idx % 50 == 0:
            sys.stderr.write(f"  进度: {idx}/{total}...\n")
        
        try:
            prefix = "sh" if code.startswith("11") else "sz"
            symbol_full = f"{prefix}{code}"
            
            df = ak.bond_zh_hs_cov_daily(symbol=symbol_full)
            
            if df.empty:
                continue
            
            df["date"] = pd.to_datetime(df["date"]).dt.strftime("%Y-%m-%d")
            day_data = df[df["date"] == date_formatted]
            
            if day_data.empty:
                continue
            
            row_data = day_data.iloc[0]
            volume = float(row_data.get("volume", 0) or 0)
            
            # 优先使用剩余规模，如果没有则使用发行规模
            scale = scale_map.get(code, 0)
            if scale == 0:
                scale = issue_scale_map.get(code, 0)
            
            if scale > 0 and volume > 0:
                turnover = volume / scale / 100000
            else:
                continue
            
            bonds.append({
                "code": code,
                "name": name,
                "price": float(row_data.get("close", 0) or 0),
                "pct": 0,
                "turnover": round(turnover, 2),
                "volume": volume,
                "curr_iss_amt": scale,
                "date": date_str,
                "source": "history",
            })
            
        except Exception as e:
            continue
    
    sys.stderr.write(f"  完成: 获取到 {len(bonds)} 只债券在 {date_str} 的数据\n")
    return bonds


def main():
    parser = argparse.ArgumentParser(description="获取可转债换手率数据")
    parser.add_argument("--top", type=int, default=20, help="返回换手率最高的 N 只")
    parser.add_argument("--sort", choices=["asc", "desc"], default="desc")
    parser.add_argument("--source", choices=["jsl", "spot", "auto"], default="auto")
    parser.add_argument("--date", type=str, default=None, help="历史日期 YYYYMMDD，如 20260703")
    args = parser.parse_args()

    if args.date:
        bonds = get_by_date(args.date)
    else:
        if args.source == "jsl":
            bonds = get_by_jsl()
        elif args.source == "spot":
            bonds = get_by_spot()
        else:
            bonds = get_by_jsl()
            if len(bonds) < 50:
                sys.stderr.write("集思录数据不足50条，补充 spot 数据...\n")
                bonds = get_by_spot()

    valid = [b for b in bonds if b["turnover"] > 0]
    reverse = args.sort == "desc"
    valid.sort(key=lambda x: x["turnover"], reverse=reverse)

    result = {
        "total": len(bonds),
        "valid": len(valid),
        "top": args.top if args.top > 0 else len(valid),
        "data": valid[:args.top] if args.top > 0 else valid,
        "date": args.date if args.date else "realtime",
    }

    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
