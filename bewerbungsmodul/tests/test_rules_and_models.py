from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.browser import domain_allowed, looks_legally_binding
from app.models import Condition, RuleGroup, WorkflowDefinition
from app.rules import evaluate_group
from app.workflow import _render_template


def test_rules_support_numbers_text_exists_and_groups():
    context = {"listing": {"price": "1.250,50 €", "rooms": "2.5", "title": "WBS Wohnung"}}
    rules = RuleGroup(
        mode="all",
        conditions=[
            Condition(field="listing.price", operator="lte", value=1300),
            Condition(field="listing.rooms", operator="gte", value=2.5),
            Condition(field="listing.title", operator="contains", value="wbs"),
            Condition(field="listing.title", operator="exists", value=True),
        ],
    )
    assert evaluate_group(rules, context)
    assert evaluate_group(
        RuleGroup(
            mode="any",
            conditions=[
                Condition(field="listing.rooms", operator="gt", value=5),
                Condition(field="listing.price", operator="eq", value="1.250,50 €"),
            ],
        ),
        context,
    )
    nested = RuleGroup(
        mode="all",
        groups=[
            RuleGroup(
                mode="any",
                conditions=[
                    Condition(field="listing.rooms", operator="eq", value="2.5"),
                    Condition(field="listing.rooms", operator="gt", value=8),
                ],
            )
        ],
    )
    assert evaluate_group(nested, context)
    assert (
        _render_template(
            "Hallo {{ profile.first_name }}, {{listing.title}}", {**context, "profile": {"first_name": "Ada"}}
        )
        == "Hallo Ada, WBS Wohnung"
    )


def test_workflow_validation_and_domain_boundary():
    with pytest.raises(ValidationError):
        WorkflowDefinition(
            id="bad",
            name="Bad",
            provider="bad",
            enabled=True,
            lifecycle="draft",
            allowed_domains=["example.test"],
            url_patterns=["example.test"],
        )
    assert domain_allowed("https://portal.example.test/a", ["example.test"])
    assert not domain_allowed("https://example.test.attacker.invalid/a", ["example.test"])
    assert looks_legally_binding("Mietvertrag unterschreiben")
    assert not looks_legally_binding("Bewerbung absenden")
