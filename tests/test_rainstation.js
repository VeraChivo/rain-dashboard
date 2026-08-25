// O-A0002-001 雨量站：選站規則、無效值處理、現況狀態推導
const { loadApp, evaluate, createChecker } = require('./harness');

const app = loadApp();
const {
  pickBestStation, buildRainStationLayer, toPrecip, deriveStateFromStation,
  buildAutoCctvStates, DIRECTION_TOWNS,
} = evaluate(app, `
exports.pickBestStation = pickBestStation;
exports.buildRainStationLayer = buildRainStationLayer;
exports.toPrecip = toPrecip;
exports.deriveStateFromStation = deriveStateFromStation;
exports.buildAutoCctvStates = buildAutoCctvStates;
exports.DIRECTION_TOWNS = DIRECTION_TOWNS;
`);

const check = createChecker();

const mkStation = (name, id, maintainer, townName, rainfall) => ({
  StationName: name, StationId: id, Maintainer: maintainer,
  GeoInfo: { TownName: townName },
  RainfallElement: rainfall,
});
const rf = (now, p10, p1h) => ({
  Now: { Precipitation: String(now) },
  Past10Min: { Precipitation: String(p10) },
  Past1hr: { Precipitation: String(p1h) },
});

// 情境 1：同名站優先（真實案例：新港鄉同時有「新港」跟「安和」兩站）
const stations1 = [
  mkStation('安和', 'C2M980', '中央氣象署', '新港鄉', rf(0, 0, 0)),
  mkStation('新港', 'C0M790', '中央氣象署', '新港鄉', rf(0, 0, 0)),
];
check(pickBestStation(stations1, '新港鄉').StationName === '新港', 'pickBestStation prefers station named exactly after the town (real 新港鄉 case)');

// 情境 2：沒有同名站時，優先中央氣象署官方站
// （真實案例：溪口鄉有水利署「溪口(3)」跟氣象署「農試溪口農場」）
const stations2 = [
  mkStation('溪口(3)', '01M010', '水利署第5河川分署', '溪口鄉', rf(0, 0, 0)),
  mkStation('農試溪口農場', 'G2M350', '中央氣象署', '溪口鄉', rf(1, 0, 0)),
];
check(pickBestStation(stations2, '溪口鄉').Maintainer === '中央氣象署', 'pickBestStation prefers 中央氣象署 official station when no exact name match exists');

// 情境 3：整個鄉鎮都沒有站 → 回 null，不能丟例外
check(pickBestStation(stations1, '不存在鄉') === null, 'pickBestStation returns null gracefully when no station matches the town');
check(pickBestStation([], '新港鄉') === null, 'pickBestStation handles empty station list gracefully');

// 情境 4：負值是氣象署的無效值標記，不是「下了負的雨」
check(toPrecip('0.0') === 0, 'toPrecip parses "0.0" as 0');
check(toPrecip('3.5') === 3.5, 'toPrecip parses "3.5" as 3.5');
check(toPrecip('-99') === null, 'toPrecip treats negative CWA sentinel value as null (no data)');
check(toPrecip(undefined) === null, 'toPrecip treats undefined as null');
check(toPrecip('abc') === null, 'toPrecip treats non-numeric string as null');

// 情境 5：deriveStateFromStation 的三個真實層級
check(deriveStateFromStation(null) === 'unknown', 'deriveStateFromStation: no station -> unknown');
check(deriveStateFromStation(mkStation('x','x','x','x', rf(-99,-99,-99))) === 'unknown', 'deriveStateFromStation: all sentinel/invalid values -> unknown');
check(deriveStateFromStation(mkStation('x','x','x','x', rf(0,0,0))) === 'dry', 'deriveStateFromStation: all zero -> dry (matches real 新港/溪口/民雄 baseline readings)');
check(deriveStateFromStation(mkStation('x','x','x','x', rf(0,0,1.5))) === 'wet', 'deriveStateFromStation: Now=0 but Past1hr>0 -> wet (recently rained, matches real 旺來山 reading)');
check(deriveStateFromStation(mkStation('x','x','x','x', rf(0,2,0))) === 'wet', 'deriveStateFromStation: Now=0 but Past10Min>0 -> wet');
check(deriveStateFromStation(mkStation('x','x','x','x', rf(1.2,1.2,1.2))) === 'raining', 'deriveStateFromStation: Now>0 -> raining (takes priority over wet)');

// 情境 6：用真實 O-A0002-001 回應裡的站名端到端跑一次
// （含 大林 站——它已不在 DIRECTION_TOWNS 裡，剛好驗證多餘的站會被濾掉）
const realStations = [
  mkStation('新港', 'C0M790', '中央氣象署', '新港鄉', rf(0, 0, 0)),
  mkStation('安和', 'C2M980', '中央氣象署', '新港鄉', rf(0, 0, 0)),
  mkStation('溪口', 'C0M660', '中央氣象署', '溪口鄉', rf(0, 0, 0)),
  mkStation('民雄', 'C0M760', '中央氣象署', '民雄鄉', rf(0, 0, 0)),
  mkStation('旺來山', 'C2M9E0', '中央氣象署', '民雄鄉', rf(0, 0, 1.5)),
  mkStation('朴子', 'C0M650', '中央氣象署', '朴子市', rf(0, 0, 0)),
  mkStation('大林', 'C0M670', '中央氣象署', '大林鎮', rf(0, 0, 0)),
  mkStation('北港', 'C0K410', '中央氣象署', '北港鎮', rf(0, 0, 0)),
  mkStation('斗南', 'C0K460', '中央氣象署', '斗南鎮', rf(0, 0, 0)),
];
const layer = buildRainStationLayer(realStations);
check(Object.keys(layer).length === Object.keys(DIRECTION_TOWNS).length, 'buildRainStationLayer produces an entry for every DIRECTION_TOWNS label');
check(layer['大林'] === undefined, 'a station for a town no longer in DIRECTION_TOWNS (大林) is dropped, not carried along');
check(layer['新港'].StationName === '新港', 'buildRainStationLayer maps 新港 label to the 新港 station (not 安和)');
check(layer['民雄'].StationName === '民雄', 'buildRainStationLayer picks 民雄 station over 旺來山 (exact name match wins)');

const autoStates = buildAutoCctvStates(layer);
check(autoStates['新港'] === 'dry' && autoStates['溪口'] === 'dry', 'buildAutoCctvStates derives dry for all-zero real baseline readings');
check(Object.keys(autoStates).length === Object.keys(DIRECTION_TOWNS).length, 'buildAutoCctvStates produces a state for every DIRECTION_TOWNS label');

check.finish();
