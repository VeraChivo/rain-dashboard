#!/usr/bin/env python3
"""
rain_tracker.py — 避雨出行決策計算報告
=========================================
資料來源：
  1. CWA 自動氣象站（O-A0001-001）風向 → 雨胞移動方向（隨時可用）
  2. 雷達回波圖（本機 PNG 檔）→ 光流法精算雨胞移動（需提供圖檔）

用法：
  # 純風向模式（不需任何額外套件）
  python3 rain_tracker.py

  # 光流模式（需 opencv-python numpy Pillow）
  python3 rain_tracker.py --frames t0.png t1.png t2.png --interval 6

  取得雷達圖：
    https://www.cwa.gov.tw/V8/C/W/Radar.html → 右鍵儲存三幀（每幀間隔約 6 分鐘）
"""

import argparse
import math
import sys
import time
from datetime import datetime, timedelta

try:
    import requests
except ImportError:
    sys.exit("請先安裝 requests：pip install requests")

CWA_KEY = "CWA-1D3F650A-CBDF-4BE9-9DE8-8869409AC7FD"

# 家 / 出發點（新港）
HOME = {"name": "新港奉天宮", "lat": 23.553, "lon": 120.347}

TOWNS = {
    "溪口":  {"lat": 23.587, "lon": 120.384, "dist_km": 7},
    "民雄":  {"lat": 23.556, "lon": 120.435, "dist_km": 12},
    "大林":  {"lat": 23.618, "lon": 120.462, "dist_km": 20},
    "斗南":  {"lat": 23.676, "lon": 120.479, "dist_km": 23},
    "北港":  {"lat": 23.569, "lon": 120.297, "dist_km": 10},
    "朴子":  {"lat": 23.464, "lon": 120.241, "dist_km": 18},
}

# CWA CV1 雷達綜合回波圖（3600×3600 像素）地理範圍（近似值）
RADAR_BOUNDS = {"N": 26.5, "S": 21.5, "W": 118.0, "E": 123.5}


# ── 座標計算 ──────────────────────────────────────────────────────────────

def haversine(lat1, lon1, lat2, lon2):
    """兩點距離（km）"""
    R = 6371
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat / 2) ** 2 + \
        math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon / 2) ** 2
    return R * 2 * math.asin(math.sqrt(a))


def bearing(lat1, lon1, lat2, lon2):
    """從點1到點2的方位角（度，N=0，順時針）"""
    dlon = math.radians(lon2 - lon1)
    lat1, lat2 = math.radians(lat1), math.radians(lat2)
    x = math.sin(dlon) * math.cos(lat2)
    y = math.cos(lat1) * math.sin(lat2) - math.sin(lat1) * math.cos(lat2) * math.cos(dlon)
    return (math.degrees(math.atan2(x, y)) + 360) % 360


def deg_to_compass(deg):
    dirs = ["北", "東北", "東", "東南", "南", "西南", "西", "西北"]
    return dirs[round(deg / 45) % 8]


# ── 方式一：CWA 自動氣象站風向 ───────────────────────────────────────────

def fetch_wind_stations():
    """從 CWA O-A0001-001 抓取嘉義縣 + 雲林縣自動站風向"""
    stations = []
    for county in ["嘉義縣", "雲林縣"]:
        url = (f"https://opendata.cwa.gov.tw/api/v1/rest/datastore/O-A0001-001"
               f"?Authorization={CWA_KEY}&CountyName={county}")
        try:
            resp = requests.get(url, timeout=10)
            resp.raise_for_status()
            data = resp.json()
            for s in data.get("records", {}).get("Station", []):
                we = s.get("WeatherElement", {})
                wdir = we.get("WindDirection") or we.get("WDIR")
                wspd = we.get("WindSpeed") or we.get("WDSD")
                if isinstance(wdir, (int, float)) and isinstance(wspd, (int, float)):
                    if 0 <= wdir <= 360 and wspd > 0:
                        stations.append({
                            "name": s.get("StationName", "?"),
                            "wdir_from": wdir,   # wind coming FROM this direction
                            "wspd_ms": wspd,
                        })
        except Exception as e:
            print(f"  [warn] {county} 風向站抓取失敗：{e}", file=sys.stderr)
    return stations


def calc_rain_vector_from_wind(stations):
    """將所有站點風速向量加總平均，得到雨胞移動方向與速度"""
    if not stations:
        return None
    sum_u = sum_v = 0
    for s in stations:
        # 風「吹向」方向 = (wind_from + 180) % 360
        rad = math.radians((s["wdir_from"] + 180) % 360)
        sum_u += s["wspd_ms"] * math.sin(rad)   # 向東分量
        sum_v += s["wspd_ms"] * math.cos(rad)   # 向北分量
    n = len(stations)
    u, v = sum_u / n, sum_v / n
    speed_ms = math.sqrt(u * u + v * v)
    if speed_ms < 0.5:
        return None
    moving_to_deg = (math.degrees(math.atan2(u, v)) + 360) % 360
    coming_from_deg = (moving_to_deg + 180) % 360
    return {
        "speed_ms":       speed_ms,
        "speed_kmh":      speed_ms * 3.6,
        "moving_to_deg":  moving_to_deg,
        "coming_from_deg": coming_from_deg,
        "source":         "wind_stations",
        "n_stations":     n,
    }


# ── 方式二：雷達回波光流法 ────────────────────────────────────────────────

def pixel_to_geo(px, py, w, h, bounds):
    lat = bounds["N"] - (py / h) * (bounds["N"] - bounds["S"])
    lon = bounds["W"] + (px / w) * (bounds["E"] - bounds["W"])
    return lat, lon


def calc_rain_vector_from_frames(frame_paths, interval_minutes=6):
    """
    以 OpenCV Farneback 光流法計算雷達回波重心位移
    frame_paths: 時間由舊到新的 2~3 幀 PNG 路徑
    interval_minutes: 每幀間隔（分鐘）
    """
    try:
        import numpy as np
        import cv2
    except ImportError:
        sys.exit("光流模式需要 opencv-python 和 numpy：pip install opencv-python numpy")

    frames = []
    for p in frame_paths:
        img = cv2.imread(p, cv2.IMREAD_GRAYSCALE)
        if img is None:
            sys.exit(f"無法讀取圖檔：{p}")
        frames.append(img)

    h, w = frames[0].shape
    threshold = 180  # 高回波強度門檻（0–255）

    def centroid(img):
        mask = (img > threshold).astype(np.uint8)
        M = cv2.moments(mask)
        if M["m00"] < 10:
            return None
        return M["m10"] / M["m00"], M["m01"] / M["m00"]

    centroids = [centroid(f) for f in frames]
    valid = [(i, c) for i, c in enumerate(centroids) if c is not None]
    if len(valid) < 2:
        return None

    # 計算最舊 → 最新的累積位移
    i0, c0 = valid[0]
    i1, c1 = valid[-1]
    dt_minutes = (i1 - i0) * interval_minutes
    if dt_minutes <= 0:
        return None

    dx_px = c1[0] - c0[0]   # 向東為正
    dy_px = c1[1] - c0[1]   # 向南為正（圖像 y 軸向下）

    # 轉換為地理距離
    lat0, lon0 = pixel_to_geo(c0[0], c0[1], w, h, RADAR_BOUNDS)
    lat1, lon1 = pixel_to_geo(c1[0], c1[1], w, h, RADAR_BOUNDS)
    dist_km = haversine(lat0, lon0, lat1, lon1)
    speed_kmh = dist_km / (dt_minutes / 60)

    moving_to_deg = bearing(lat0, lon0, lat1, lon1)
    coming_from_deg = (moving_to_deg + 180) % 360

    # 光流向量圖輔助驗證（最後一對幀）
    flow = cv2.calcOpticalFlowFarneback(
        frames[-2], frames[-1], None,
        pyr_scale=0.5, levels=3, winsize=15,
        iterations=3, poly_n=5, poly_sigma=1.2, flags=0
    )
    mag, ang = cv2.cartToPolar(flow[..., 0], -flow[..., 1])  # -y = N
    mask = (frames[-1] > threshold)
    mean_angle_rad = float(np.mean(ang[mask])) if mask.any() else 0
    flow_dir_deg = (math.degrees(mean_angle_rad) + 360) % 360

    return {
        "speed_ms":        speed_kmh / 3.6,
        "speed_kmh":       speed_kmh,
        "moving_to_deg":   moving_to_deg,
        "coming_from_deg": coming_from_deg,
        "flow_dir_deg":    flow_dir_deg,
        "source":          "radar_optical_flow",
        "frames":          len(frames),
        "dist_km":         dist_km,
        "dt_min":          dt_minutes,
    }


# ── 路線風險計算 ──────────────────────────────────────────────────────────

def route_risk(town_bearing, coming_from_deg):
    """
    diff=0   → 正面迎向雨胞來源 → 最高風險
    diff=180 → 背向雨胞來源   → 最低風險
    """
    diff = abs(((town_bearing - coming_from_deg) + 180) % 360 - 180)
    if diff <= 45:
        return {"level": "高風險", "score": 0, "note": "直衝雨胞來向，出發即遭遇降雨"}
    elif diff <= 90:
        return {"level": "中風險", "score": 1, "note": "雨胞從側面穿越路徑"}
    elif diff <= 135:
        return {"level": "低風險", "score": 2, "note": "方向偏離雨胞，相對安全"}
    else:
        return {"level": "最佳",   "score": 3, "note": "背向雨胞來源，緩衝時間最長"}


def calc_time_budget(town_name, town_info, rain_vec, now):
    """估算雨胞抵達目的地的時間（僅供參考，需搭配雷達確認雨胞當前位置）"""
    if rain_vec is None or rain_vec["speed_kmh"] < 2:
        return None
    dist = town_info.get("dist_km", 0)
    mins = dist / rain_vec["speed_kmh"] * 60
    arrive_at = now + timedelta(minutes=mins)
    return {"eta_minutes": round(mins), "eta_time": arrive_at.strftime("%H:%M")}


# ── 報告輸出 ──────────────────────────────────────────────────────────────

def print_report(rain_vec, now):
    border = "=" * 45
    print(f"\n{border}")
    print("  避雨出行決策計算報告")
    print(border)

    if rain_vec is None:
        print("\n⚠ 無法取得雨胞移動資料（風速過低或資料缺失）")
        return

    from_dir = deg_to_compass(rain_vec["coming_from_deg"])
    to_dir   = deg_to_compass(rain_vec["moving_to_deg"])
    spd      = rain_vec["speed_kmh"]

    print(f"\n【雨胞追蹤軌跡】（資料來源：{rain_vec['source']}）")
    print(f"  移動方向：雨從 [{from_dir}] 往 [{to_dir}] 飄移")
    print(f"  推估時速：{spd:.1f} km/h")
    if "dist_km" in rain_vec:
        print(f"  偵測位移：{rain_vec['dist_km']:.1f} km / {rain_vec['dt_min']} 分鐘")
    if "n_stations" in rain_vec:
        print(f"  參考站數：{rain_vec['n_stations']} 個自動氣象站")

    # 計算各方向風險
    routes = []
    for name, info in TOWNS.items():
        brng = bearing(HOME["lat"], HOME["lon"], info["lat"], info["lon"])
        risk = route_risk(brng, rain_vec["coming_from_deg"])
        budget = calc_time_budget(name, info, rain_vec, now)
        routes.append({
            "name": name, "bearing": brng, "risk": risk,
            "dist": info["dist_km"], "budget": budget,
        })
    routes.sort(key=lambda r: (-r["risk"]["score"], r["dist"]))

    print(f"\n【出門方向與路徑優先順序】（出發點：{HOME['name']}）")
    for i, r in enumerate(routes, 1):
        brng_dir = deg_to_compass(r["bearing"])
        budget   = r["budget"]
        eta_str  = f"  雨胞約 {budget['eta_minutes']} 分鐘後抵達（估計 {budget['eta_time']} 前出發可避開）" \
                   if budget else ""
        print(f"\n  優先級 {i}：往{r['name']}（{brng_dir}向，距 {r['dist']} km）")
        print(f"    風險：{r['risk']['level']} — {r['risk']['note']}")
        if eta_str:
            print(f"   {eta_str}")

    print(f"\n  計算時間：{now.strftime('%Y/%m/%d %H:%M')}")
    print(f"{border}\n")


# ── 主程式 ───────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="台灣避雨出行決策計算器")
    parser.add_argument("--frames", nargs="+", metavar="PNG",
                        help="2~3 幀雷達回波圖（時間由舊到新），使用光流法計算")
    parser.add_argument("--interval", type=int, default=6,
                        help="每幀時間間隔（分鐘，預設 6）")
    args = parser.parse_args()

    now = datetime.now()

    if args.frames:
        print(f"[光流模式] 讀取 {len(args.frames)} 幀雷達圖，間隔 {args.interval} 分鐘…")
        rain_vec = calc_rain_vector_from_frames(args.frames, args.interval)
        if rain_vec is None:
            print("[warn] 光流法未能識別雨胞，改用風向站資料…")
            stations = fetch_wind_stations()
            rain_vec = calc_rain_vector_from_wind(stations)
    else:
        print("[風向模式] 抓取 CWA 自動氣象站資料…")
        stations = fetch_wind_stations()
        print(f"  取得 {len(stations)} 個站點")
        rain_vec = calc_rain_vector_from_wind(stations)

    print_report(rain_vec, now)


if __name__ == "__main__":
    main()
