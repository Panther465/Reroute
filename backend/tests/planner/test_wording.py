"""Explanation wording: never "0 min later", and a fixed task at risk says when you arrive against its start."""

from __future__ import annotations

from app.services.planner import ReplanInput, Start, explain, plan_day, replan

from .conftest import WF, t


def test_finishing_early_says_earlier_not_zero_minutes_later(demo_input):
    v1 = plan_day(demo_input)
    meeting = next(leg for leg in v1.legs if leg.task_id == "task-meet")
    remaining = [leg for leg in v1.legs if leg.seq > meeting.seq]
    # The meeting ended 20 minutes early: the bank leg can leave at 10:45 instead of 11:05.
    planner = demo_input.model_copy(update={"tasks": demo_input.tasks[1:], "start": Start(place_id=WF, ready_at=meeting.task_end - 20, kind="after_task")})
    result = replan(
        ReplanInput(
            planner=planner,
            active_order=tuple((leg.task_id, leg.option.option_id) for leg in remaining),
            active_leave_times=tuple(leg.leave_by for leg in remaining),
            today_task_count=3,
        )
    )
    assert result.result == "shifted"
    assert result.explanation == "Your day still fits. Your next stop moves 20 min earlier. No extra cost."


def test_shift_wording_never_says_zero_minutes():
    assert explain.shifted(15, False) == "Your day still fits. Every later stop moves 15 min later. No extra cost."
    assert explain.shifted(-10, False) == "Your day still fits. Your next stop moves 10 min earlier. No extra cost."
    assert "0 min" not in explain.shifted(0, False) and "0 min" not in explain.shifted(0, True, 5)
    assert explain.shifted(25, True, 25) == "You were 25 min behind. Reroute moved your later stops 25 min later."


def test_fixed_task_at_risk_says_after_the_start_only_when_it_is():
    assert explain.fixed_at_risk("Meeting", t(10, 20), t(10), 10) == "You'll reach the meeting at about 10:20, after its 10:00 start."
    early = explain.fixed_at_risk("Meeting", t(9, 55), t(10), 10)
    assert early == "You'll reach the meeting at about 09:55, 5 min before its 10:00 start; you need 10."
    assert "after" not in explain.fixed_at_risk("Meeting", t(10), t(10), 10)
