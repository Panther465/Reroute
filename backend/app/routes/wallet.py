"""The wallet: simulated money for simulated bookings. Like bookings, it exists only with DEMO_LOGIN=true."""

from __future__ import annotations

from fastapi import APIRouter, Depends

from app.deps import CurrentUser, Db, demo_only
from app.schemas import TopUpIn, WalletEntryOut, WalletOut
from app.services import wallet

router = APIRouter(prefix="/v1", tags=["wallet"], dependencies=[Depends(demo_only)])


def _out(db, user_id: str) -> WalletOut:
    return WalletOut(balance_inr=wallet.balance(db, user_id), entries=[WalletEntryOut.model_validate(e) for e in wallet.entries(db, user_id)])


@router.get("/wallet", response_model=WalletOut, response_model_by_alias=True, summary="Your wallet: the balance and its latest entries (simulated money)")
def get_wallet(user: CurrentUser, db: Db) -> WalletOut:
    return _out(db, user.user_id)


@router.post("/wallet/topups", response_model=WalletOut, response_model_by_alias=True, status_code=201, summary="Add simulated money to your wallet")
def top_up(body: TopUpIn, user: CurrentUser, db: Db) -> WalletOut:
    wallet.top_up(db, user.user_id, body.amount_inr)
    db.commit()
    return _out(db, user.user_id)
