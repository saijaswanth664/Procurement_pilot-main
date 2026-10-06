#!/usr/bin/env python3
"""Explainable 14-day supplier forecasts (ridge, one model family per target).

Trains per supplier on supplier_metrics history. Direct h-day-ahead ridge:
features at day t predict the metric on day t+horizon (default 14).

  python scripts/predict_supplier_performance.py --csv metrics.csv
  python scripts/predict_supplier_performance.py --csv metrics.csv --write-sql /tmp/forecasts.sql

Reliability is delivery reliability, not 1 - defect_rate:
  1 / (1 + max(0, lead - 28d median lead) / 28d median).
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import sys
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path
from typing import Sequence

import numpy as np
from sklearn.linear_model import Ridge
from sklearn.metrics import mean_absolute_error
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

HORIZON_DAYS = 14
ROLL = 28
HOLD_OUT = 28
RIDGE_ALPHA = 1.0
MODEL_TYPE = "ridge_direct_14d"


@dataclass(frozen=True)
class Prediction:
    value: float
    std: float
    mae: float
    n_train: int
    n_holdout: int
    model_type: str = MODEL_TYPE

    def interval_80(self) -> tuple[float, float]:
        """Normal approx: ±1.28 residual std around the point forecast."""
        width = 1.28 * self.std
        return (self.value - width, self.value + width)


def _parse_date(value: str) -> date:
    return date.fromisoformat(value[:10])


def calendar_flags(d: date, is_raw_herb: bool) -> dict[str, float]:
    """Known India logistics windows (aligned with the AyuraNest seed)."""
    holi = date(d.year, 3, 1) <= d <= date(d.year, 3, 8)
    eid = date(d.year, 3, 18) <= d <= date(d.year, 3, 26)
    monsoon = d.month in (6, 7, 8)
    monsoon_depth = 0.0
    if monsoon:
        monsoon_depth = ((d.month - 6) + d.day / 31.0) / 3.0
    herb = 1.0 if is_raw_herb else 0.0
    doy = d.timetuple().tm_yday
    return {
        "is_holi": 1.0 if holi else 0.0,
        "is_eid": 1.0 if eid else 0.0,
        "is_monsoon": 1.0 if monsoon else 0.0,
        "monsoon_depth": monsoon_depth,
        "herb_x_monsoon": herb * (1.0 if monsoon else 0.0),
        "herb_x_festival": herb * (1.0 if (holi or eid) else 0.0),
        "month_sin": math.sin(2 * math.pi * d.month / 12.0),
        "month_cos": math.cos(2 * math.pi * d.month / 12.0),
        "doy_sin": math.sin(2 * math.pi * doy / 365.25),
        "doy_cos": math.cos(2 * math.pi * doy / 365.25),
        "is_raw_herb": herb,
    }


def delivery_reliability(lead: np.ndarray) -> np.ndarray:
    """On-time-ish score: 1 when lead <= 28d median, decays as lateness grows."""
    n = len(lead)
    out = np.ones(n, dtype=float)
    for i in range(n):
        lo = max(0, i - ROLL + 1)
        med = float(np.median(lead[lo : i + 1])) if i >= 6 else float(np.median(lead[: i + 1]))
        med = max(med, 1e-6)
        late = max(0.0, float(lead[i]) - med)
        out[i] = 1.0 / (1.0 + late / med)
    return out


def _rolling_mean(x: np.ndarray, window: int) -> np.ndarray:
    out = np.full_like(x, np.nan, dtype=float)
    csum = np.cumsum(np.insert(x.astype(float), 0, 0.0))
    for i in range(len(x)):
        w = min(window, i + 1)
        out[i] = (csum[i + 1] - csum[i + 1 - w]) / w
    return out


def _rolling_std(x: np.ndarray, window: int) -> np.ndarray:
    out = np.zeros_like(x, dtype=float)
    for i in range(len(x)):
        lo = max(0, i - window + 1)
        chunk = x[lo : i + 1]
        out[i] = float(np.std(chunk, ddof=0)) if len(chunk) > 1 else 0.0
    return out


def _lag(x: np.ndarray, k: int) -> np.ndarray:
    out = np.full_like(x, np.nan, dtype=float)
    if k < len(x):
        out[k:] = x[:-k]
    return out


LEVEL_FEATURES = [
    "t_norm",
    "y",
    "y_lag1",
    "y_lag7",
    "y_lag14",
    "y_roll7",
    "y_roll14",
    "y_roll28",
    "y_trend",
    "y_vol7",
    "util",
    "util_roll7",
    "util_trend",
]
CALENDAR_FEATURES = [
    "is_holi",
    "is_eid",
    "is_monsoon",
    "monsoon_depth",
    "herb_x_monsoon",
    "herb_x_festival",
    "month_sin",
    "month_cos",
    "doy_sin",
    "doy_cos",
    "is_raw_herb",
]


def build_feature_matrix(
    dates: Sequence[date],
    y: np.ndarray,
    util: np.ndarray,
    is_raw_herb: bool,
    *,
    for_target_dates: Sequence[date] | None = None,
    use_calendar: bool = True,
) -> np.ndarray:
    """Row i uses history through i; calendar features use for_target_dates[i] (horizon day)."""
    n = len(y)
    t_norm = np.arange(n, dtype=float) / max(n - 1, 1)
    y_lag1 = _lag(y, 1)
    y_lag7 = _lag(y, 7)
    y_lag14 = _lag(y, 14)
    y_r7 = _rolling_mean(y, 7)
    y_r14 = _rolling_mean(y, 14)
    y_r28 = _rolling_mean(y, 28)
    y_trend = y_r7 - y_r28
    y_vol7 = _rolling_std(y, 7)
    u_r7 = _rolling_mean(util, 7)
    u_r28 = _rolling_mean(util, 28)
    u_trend = u_r7 - u_r28

    cal_dates = list(for_target_dates) if for_target_dates is not None else list(dates)
    rows = []
    for i in range(n):
        cal = calendar_flags(cal_dates[i], is_raw_herb)
        row = {
            "t_norm": t_norm[i],
            "y": y[i],
            "y_lag1": y_lag1[i] if not np.isnan(y_lag1[i]) else y[i],
            "y_lag7": y_lag7[i] if not np.isnan(y_lag7[i]) else y[i],
            "y_lag14": y_lag14[i] if not np.isnan(y_lag14[i]) else y[i],
            "y_roll7": y_r7[i],
            "y_roll14": y_r14[i],
            "y_roll28": y_r28[i],
            "y_trend": y_trend[i],
            "y_vol7": y_vol7[i],
            "util": util[i],
            "util_roll7": u_r7[i],
            "util_trend": u_trend[i],
            **cal,
        }
        keys = LEVEL_FEATURES + (CALENDAR_FEATURES if use_calendar else [])
        rows.append([row[k] for k in keys])
    return np.asarray(rows, dtype=float)


def _fit_direct_ridge(
    X: np.ndarray,
    y_ahead: np.ndarray,
    valid: np.ndarray,
    clip: tuple[float, float] | None,
) -> tuple[Pipeline, Prediction]:
    idx = np.where(valid)[0]
    if len(idx) < HOLD_OUT + 20:
        raise ValueError(f"not enough samples to train ({len(idx)})")
    hold_n = min(HOLD_OUT, len(idx) // 4)
    train_idx, test_idx = idx[:-hold_n], idx[-hold_n:]
    pipe = Pipeline(
        [
            ("scaler", StandardScaler()),
            ("ridge", Ridge(alpha=RIDGE_ALPHA)),
        ]
    )
    pipe.fit(X[train_idx], y_ahead[train_idx])
    pred_te = pipe.predict(X[test_idx])
    mae = float(mean_absolute_error(y_ahead[test_idx], pred_te))
    resid = y_ahead[test_idx] - pred_te
    std = float(np.std(resid, ddof=1)) if len(resid) > 1 else mae
    pipe.fit(X[idx], y_ahead[idx])
    last = float(pipe.predict(X[[-1]])[0])
    if clip is not None:
        last = min(clip[1], max(clip[0], last))
    return pipe, Prediction(
        value=last,
        std=max(std, 1e-9),
        mae=mae,
        n_train=len(train_idx),
        n_holdout=len(test_idx),
    )


def _ahead_valid(n: int, horizon: int, min_hist: int) -> np.ndarray:
    valid = np.zeros(n, dtype=bool)
    valid[min_hist : n - horizon] = True
    return valid


def _target_dates(dates: Sequence[date], horizon: int) -> list[date]:
    return [d + timedelta(days=horizon) for d in dates]


def predict_price(
    dates: Sequence[date],
    price: np.ndarray,
    util: np.ndarray,
    is_raw_herb: bool,
    horizon: int = HORIZON_DAYS,
) -> Prediction:
    """14-day-ahead price. Features: lags/rolls + slow t_norm (random-walk level)."""
    y = price.astype(float)
    X = build_feature_matrix(
        dates, y, util, is_raw_herb, for_target_dates=dates, use_calendar=False
    )
    ahead = np.roll(y, -horizon)
    valid = _ahead_valid(len(y), horizon, ROLL)
    lo, hi = float(np.min(y)) * 0.7, float(np.max(y)) * 1.4
    _, pred = _fit_direct_ridge(X, ahead, valid, (max(lo, 0.01), hi))
    return pred


def predict_reliability(
    dates: Sequence[date],
    lead: np.ndarray,
    util: np.ndarray,
    is_raw_herb: bool,
    horizon: int = HORIZON_DAYS,
) -> Prediction:
    """14-day-ahead delivery reliability (lateness vs 28d median lead)."""
    y = delivery_reliability(lead.astype(float))
    X = build_feature_matrix(
        dates, y, util, is_raw_herb, for_target_dates=_target_dates(dates, horizon), use_calendar=True
    )
    ahead = np.roll(y, -horizon)
    valid = _ahead_valid(len(y), horizon, ROLL)
    _, pred = _fit_direct_ridge(X, ahead, valid, (0.05, 1.0))
    return pred


def predict_lead_time(
    dates: Sequence[date],
    lead: np.ndarray,
    util: np.ndarray,
    is_raw_herb: bool,
    horizon: int = HORIZON_DAYS,
) -> Prediction:
    """14-day-ahead lead time. Calendar on the *target* date (monsoon/festival)."""
    y = lead.astype(float)
    X = build_feature_matrix(
        dates, y, util, is_raw_herb, for_target_dates=_target_dates(dates, horizon), use_calendar=True
    )
    ahead = np.roll(y, -horizon)
    valid = _ahead_valid(len(y), horizon, ROLL)
    _, pred = _fit_direct_ridge(X, ahead, valid, (3.0, 45.0))
    return pred


def predict_defect_rate(
    dates: Sequence[date],
    defect: np.ndarray,
    util: np.ndarray,
    is_raw_herb: bool,
    horizon: int = HORIZON_DAYS,
) -> Prediction:
    """14-day-ahead quality-risk. y_trend (7d vs 28d mean) captures degradation."""
    y = defect.astype(float)
    X = build_feature_matrix(
        dates, y, util, is_raw_herb, for_target_dates=dates, use_calendar=False
    )
    ahead = np.roll(y, -horizon)
    valid = _ahead_valid(len(y), horizon, ROLL)
    _, pred = _fit_direct_ridge(X, ahead, valid, (0.0005, 0.25))
    return pred


def predict_capacity_util(
    dates: Sequence[date],
    util: np.ndarray,
    is_raw_herb: bool,
    horizon: int = HORIZON_DAYS,
) -> Prediction:
    """14-day-ahead monthly utilization. util_trend is the ceiling-approach signal."""
    y = util.astype(float)
    X = build_feature_matrix(
        dates, y, util, is_raw_herb, for_target_dates=dates, use_calendar=False
    )
    ahead = np.roll(y, -horizon)
    valid = _ahead_valid(len(y), horizon, ROLL)
    _, pred = _fit_direct_ridge(X, ahead, valid, (0.05, 0.99))
    return pred


def load_metrics_csv(path: Path) -> list[dict]:
    rows: list[dict] = []
    with path.open(newline="") as f:
        reader = csv.DictReader(f)
        for raw in reader:
            rows.append(
                {
                    "supplier_id": int(raw["supplier_id"]),
                    "name": raw["name"],
                    "category": raw["category"],
                    "max_capacity": float(raw["max_capacity"]),
                    "date": _parse_date(raw["date"]),
                    "price": float(raw["price"]),
                    "defect_rate": float(raw["defect_rate"]),
                    "lead_time_days": float(raw["lead_time_days"]),
                    "capacity_used": float(raw["capacity_used"]),
                }
            )
    return rows


def group_by_supplier(rows: list[dict]) -> dict[int, list[dict]]:
    groups: dict[int, list[dict]] = {}
    for row in rows:
        groups.setdefault(row["supplier_id"], []).append(row)
    for sid in groups:
        groups[sid].sort(key=lambda r: r["date"])
    return groups


def forecast_supplier(series: list[dict], horizon: int = HORIZON_DAYS) -> dict:
    dates = [r["date"] for r in series]
    price = np.array([r["price"] for r in series], dtype=float)
    defect = np.array([r["defect_rate"] for r in series], dtype=float)
    lead = np.array([r["lead_time_days"] for r in series], dtype=float)
    used = np.array([r["capacity_used"] for r in series], dtype=float)
    max_cap = float(series[0]["max_capacity"])
    util = used * 30.0 / max_cap
    herb = series[0]["category"] == "raw_herbs"

    p = predict_price(dates, price, util, herb, horizon)
    r = predict_reliability(dates, lead, util, herb, horizon)
    lt = predict_lead_time(dates, lead, util, herb, horizon)
    q = predict_defect_rate(dates, defect, util, herb, horizon)
    c = predict_capacity_util(dates, util, herb, horizon)

    as_of = dates[-1]
    return {
        "supplier_id": series[0]["supplier_id"],
        "name": series[0]["name"],
        "category": series[0]["category"],
        "forecast_date": as_of,
        "horizon_days": horizon,
        "predicted_price": p,
        "predicted_reliability": r,
        "predicted_lead_time": lt,
        "predicted_defect_rate": q,
        "predicted_capacity_util": c,
        "last_price": float(price[-1]),
        "last_reliability": float(delivery_reliability(lead)[-1]),
        "last_lead": float(lead[-1]),
        "last_defect": float(defect[-1]),
        "last_util": float(util[-1]),
    }


def _unc(pred: Prediction, bounds: tuple[float, float] | None = None) -> dict:
    lo, hi = pred.interval_80()
    if bounds is not None:
        lo = max(bounds[0], lo)
        hi = min(bounds[1], hi)
    return {
        "std": round(pred.std, 6),
        "mae_holdout": round(pred.mae, 6),
        "n_holdout": pred.n_holdout,
        "interval_80": [round(lo, 6), round(hi, 6)],
    }


def forecasts_to_sql(forecasts: list[dict]) -> str:
    lines = [
        "-- Idempotent 14-day ridge forecasts. Generated by scripts/predict_supplier_performance.py",
        """insert into public.supplier_forecasts (
  supplier_id, forecast_date, horizon_days,
  predicted_price, predicted_reliability, predicted_lead_time,
  predicted_defect_rate, predicted_capacity_util,
  model_type, uncertainty, generated_at
) values""",
    ]
    value_rows = []
    for f in forecasts:
        unc = {
            "price": _unc(f["predicted_price"]),
            "reliability": _unc(f["predicted_reliability"], (0.0, 1.0)),
            "lead_time": _unc(f["predicted_lead_time"], (0.0, 45.0)),
            "defect_rate": _unc(f["predicted_defect_rate"], (0.0, 0.25)),
            "capacity_util": _unc(f["predicted_capacity_util"], (0.0, 1.0)),
        }
        unc_sql = "'" + json.dumps(unc).replace("'", "''") + "'::jsonb"
        value_rows.append(
            "  ("
            f"{f['supplier_id']}, '{f['forecast_date'].isoformat()}'::date, {f['horizon_days']}, "
            f"{f['predicted_price'].value:.6f}, {f['predicted_reliability'].value:.6f}, "
            f"{f['predicted_lead_time'].value:.6f}, {f['predicted_defect_rate'].value:.6f}, "
            f"{f['predicted_capacity_util'].value:.6f}, '{MODEL_TYPE}', {unc_sql}, now())"
        )
    lines.append(",\n".join(value_rows))
    lines.append(
        """on conflict (supplier_id, forecast_date, horizon_days) do update set
  predicted_price = excluded.predicted_price,
  predicted_reliability = excluded.predicted_reliability,
  predicted_lead_time = excluded.predicted_lead_time,
  predicted_defect_rate = excluded.predicted_defect_rate,
  predicted_capacity_util = excluded.predicted_capacity_util,
  model_type = excluded.model_type,
  uncertainty = excluded.uncertainty,
  generated_at = excluded.generated_at;"""
    )
    return "\n".join(lines) + "\n"


def print_accuracy(forecasts: list[dict]) -> None:
    header = (
        f"{'supplier':<28} {'cat':<22} "
        f"{'price MAE':>10} {'rel MAE':>10} {'lead MAE':>10} "
        f"{'defect MAE':>11} {'util MAE':>10}"
    )
    print(header)
    print("-" * len(header))
    for f in forecasts:
        print(
            f"{f['name']:<28} {f['category']:<22} "
            f"{f['predicted_price'].mae:10.3f} "
            f"{f['predicted_reliability'].mae:10.4f} "
            f"{f['predicted_lead_time'].mae:10.3f} "
            f"{f['predicted_defect_rate'].mae:11.5f} "
            f"{f['predicted_capacity_util'].mae:10.4f}"
        )
    print()
    print("Holdout = last 28 days with a realized t+14 label. MAE is in the same units as the target.")
    print("price INR/unit, rel [0-1], lead days, defect rate [0-1], util monthly fraction.")
    print()
    print(
        f"{'supplier':<28} {'price':>10} {'rel':>8} {'lead':>8} {'defect%':>9} {'util':>8}  (point @ t+14)"
    )
    print("-" * 80)
    for f in forecasts:
        print(
            f"{f['name']:<28} "
            f"{f['predicted_price'].value:10.2f} "
            f"{f['predicted_reliability'].value:8.3f} "
            f"{f['predicted_lead_time'].value:8.2f} "
            f"{f['predicted_defect_rate'].value * 100:8.2f}% "
            f"{f['predicted_capacity_util'].value:8.3f}"
        )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--csv", type=Path, required=True, help="Metrics export (see load_metrics_csv).")
    parser.add_argument("--horizon", type=int, default=HORIZON_DAYS)
    parser.add_argument("--write-sql", type=Path, help="Idempotent upsert SQL for supplier_forecasts.")
    args = parser.parse_args()

    rows = load_metrics_csv(args.csv)
    if not rows:
        print("no rows in csv", file=sys.stderr)
        return 1
    forecasts = [forecast_supplier(series, args.horizon) for series in group_by_supplier(rows).values()]
    forecasts.sort(key=lambda f: (f["category"], f["name"]))
    print_accuracy(forecasts)
    if args.write_sql:
        args.write_sql.write_text(forecasts_to_sql(forecasts))
        print(f"wrote {args.write_sql}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
