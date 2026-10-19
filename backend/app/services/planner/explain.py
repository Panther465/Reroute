"""Explanations built from reason codes with fixed sentence templates. No AI model is involved."""

from __future__ import annotations

from .util import count_word, hhmm, lower_first, rupees


def shifted(minutes: int, automatic: bool, behind_min: int | None = None) -> str:
    if automatic and behind_min:
        return f"You were {behind_min} min behind. Reroute moved your later stops {minutes} min later."
    return f"Your day still fits. Every later stop moves {minutes} min later. No extra cost."


def on_time() -> str:
    return "You're on time. Nothing changed."


def must_choose(failure: str | None, title: str | None, at: int | None) -> str:
    name = lower_first(title) if title else "next stop"
    if failure == "window" and at is not None:
        return f"The {name} closes at {hhmm(at)}. Choose how to fix the rest of today."
    if failure == "fixed" and at is not None:
        return f"The {name} starts at {hhmm(at)}. Choose how to fix the rest of today."
    if failure == "service":
        return f"The last shared auto for the {name} will have gone. Choose how to fix the rest of today."
    if failure == "unavailable":
        return f"The shared auto route to the {name} isn't confirmed right now. Choose how to fix the rest of today."
    return "Your later stops no longer fit. Choose how to fix the rest of today."


def faster_label(dest_title: str | None, uses_cab: bool) -> str:
    if dest_title is None:
        return "Take a cab back" if uses_cab else "Take a faster way back"
    return f"Take a cab to the {lower_first(dest_title)}" if uses_cab else f"Take a faster way to the {lower_first(dest_title)}"


def faster_consequence(today_count: int) -> str:
    return f"All {count_word(today_count)} tasks still happen today"


def faster_explanation(today_count: int, extra: int, uses_cab: bool) -> str:
    how = "A cab" if uses_cab else "A faster route"
    if extra > 0:
        return f"{how} keeps all {count_word(today_count)} tasks today for {rupees(extra)} more."
    return f"{how} keeps all {count_word(today_count)} tasks today at no extra cost."


def moved_consequence(moved: list[tuple[str, int | None]]) -> str:
    if len(moved) == 1:
        title, at = moved[0]
        when = f", {hhmm(at)}" if at is not None else ""
        return f"The {lower_first(title)} moves to tomorrow{when}"
    return f"{count_word(len(moved)).capitalize()} tasks move to tomorrow"


def moved_explanation(moved: list[tuple[str, int | None]], extra: int) -> str:
    cost = "at no extra cost" if extra <= 0 else f"for {rupees(extra)} more"
    if len(moved) == 1:
        title, at = moved[0]
        when = f" at {hhmm(at)}" if at is not None else ""
        return f"Moving the {lower_first(title)} to tomorrow{when} keeps the rest of today {cost}."
    return f"Moving {count_word(len(moved))} tasks to tomorrow keeps the rest of today {cost}."


def skipped_label(titles: list[str]) -> str:
    return f"Skip the {lower_first(titles[0])}" if len(titles) == 1 else f"Skip {count_word(len(titles))} tasks"


def skipped_consequence(titles: list[str]) -> str:
    return f"The {lower_first(titles[0])} is skipped today" if len(titles) == 1 else f"{count_word(len(titles)).capitalize()} tasks are skipped today"


def skipped_explanation(titles: list[str], extra: int) -> str:
    cost = "at no extra cost" if extra <= 0 else f"for {rupees(extra)} more"
    return (
        f"Skipping the {lower_first(titles[0])} keeps every other stop {cost}."
        if len(titles) == 1
        else f"Skipping {count_word(len(titles))} low-priority tasks keeps every other stop {cost}."
    )


def created(n_tasks: int, approximate: bool) -> str:
    base = f"Planned {count_word(n_tasks)} {'task' if n_tasks == 1 else 'tasks'} with the lowest travel time and fare."
    if approximate:
        base += " With this many tasks the order is a good estimate, not guaranteed to be the cheapest."
    return base + " Times and fares are estimates."
