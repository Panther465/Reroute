"""Roo as an agent: it reads the trip through tools, puts every change it would make on one card, and makes
them only when the traveller taps Do all (routes/roo.py). Undo takes the card back.

- internal.py: Roo calls the app's own API, in this process, signed in as the traveller.
- prompt.py: who Roo is, and the day in words for the model.
- tools.py: what Roo can read and change; every change is checked before it goes on the card.
- agent.py: one message in, Roo's reply out (a few model steps with tools).
- proposals.py: the card kept for 15 minutes, run in order when confirmed, and undone.
"""
