"""Deterministic condition evaluation without executable user code."""

from __future__ import annotations

import re
from collections.abc import Mapping
from typing import Any

from app.models import Condition, RuleGroup


def resolve_path(context: Mapping[str, Any], path: str) -> Any:
    current: Any = context
    for part in path.split("."):
        if isinstance(current, Mapping):
            current = current.get(part)
        else:
            current = getattr(current, part, None)
        if current is None:
            return None
    return current


def as_number(value: Any) -> float | None:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, int | float):
        return float(value)
    # Accept the legacy notification units, but never turn arbitrary text into a number.
    match = re.fullmatch(r"\s*([+-]?[\d.,\s]+)\s*(?:€|EUR|m²|Zimmer|rooms|Odalar)?\s*", str(value), re.I)
    if not match:
        return None
    cleaned = re.sub(r"\s", "", match.group(1))
    if "," in cleaned and "." in cleaned:
        if cleaned.rfind(",") > cleaned.rfind("."):
            cleaned = cleaned.replace(".", "").replace(",", ".")
        else:
            cleaned = cleaned.replace(",", "")
    elif re.fullmatch(r"[+-]?\d{1,3}(?:\.\d{3})+", cleaned):
        cleaned = cleaned.replace(".", "")
    elif "," in cleaned:
        cleaned = cleaned.replace(",", ".")
    try:
        return float(cleaned)
    except ValueError:
        return None


def evaluate_condition(condition: Condition, context: Mapping[str, Any]) -> bool:
    actual = resolve_path(context, condition.field)
    expected = condition.value
    operator = condition.operator

    if operator == "exists":
        return (actual is not None and actual != "") is bool(expected if expected is not None else True)
    if operator in {"eq", "neq"}:
        if isinstance(expected, bool):
            equal = type(actual) is bool and actual == expected
        elif isinstance(expected, int | float):
            equal = as_number(actual) == expected
        else:
            equal = actual == expected
        return equal if operator == "eq" else not equal
    if operator == "contains":
        return str(expected).casefold() in str(actual or "").casefold()
    if operator == "not_contains":
        return str(expected).casefold() not in str(actual or "").casefold()
    if operator == "matches":
        return re.search(str(expected), str(actual or ""), flags=re.IGNORECASE) is not None

    left = as_number(actual)
    right = as_number(expected)
    if left is None or right is None:
        return False
    comparisons = {
        "gt": left > right,
        "gte": left >= right,
        "lt": left < right,
        "lte": left <= right,
    }
    return comparisons[operator]


def evaluate_group(group: RuleGroup | None, context: Mapping[str, Any], *, nested: bool = False) -> bool:
    if group is None:
        return True
    if not group.conditions and not group.groups:
        return not nested and group.mode == "all"
    results = [evaluate_condition(condition, context) for condition in group.conditions]
    results.extend(evaluate_group(child, context, nested=True) for child in group.groups)
    return all(results) if group.mode == "all" else any(results)
