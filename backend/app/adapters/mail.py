"""Email through SMTP: a provider's server in production, or Mailpit in development (docker-compose.yml).

Only the worker sends (workers/jobs.py): a slow mail server never holds up a request.
"""

from __future__ import annotations

import smtplib
import ssl
from email.message import EmailMessage
from email.utils import formatdate, make_msgid, parseaddr

from app.config import get_settings


class MailOff(RuntimeError):
    """SMTP_HOST isn't set: this server sends no email."""


def send(to: str, subject: str, text: str, html: str | None = None) -> None:
    """Send one message, plain text with an optional HTML version. Raises on any SMTP failure, so the job retries."""
    s = get_settings()
    if not s.smtp_host:
        raise MailOff("SMTP_HOST isn't set.")
    msg = EmailMessage()
    msg["From"] = s.mail_from
    msg["To"] = to
    msg["Subject"] = subject
    msg["Date"] = formatdate(usegmt=True)
    domain = parseaddr(s.mail_from)[1].partition("@")[2] or "reroute.example"
    msg["Message-ID"] = make_msgid(domain=domain)
    # Mail that people asked for: tell auto-responders not to answer it.
    msg["Auto-Submitted"] = "auto-generated"
    msg.set_content(text)
    if html:
        msg.add_alternative(html, subtype="html")
    if s.smtp_security == "ssl":
        smtp: smtplib.SMTP = smtplib.SMTP_SSL(s.smtp_host, s.smtp_port, timeout=15, context=ssl.create_default_context())
    else:
        smtp = smtplib.SMTP(s.smtp_host, s.smtp_port, timeout=15)
    with smtp:
        if s.smtp_security == "starttls":
            smtp.starttls(context=ssl.create_default_context())
        if s.smtp_user:
            smtp.login(s.smtp_user, s.smtp_password)
        smtp.send_message(msg)
