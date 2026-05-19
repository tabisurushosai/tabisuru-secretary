"""Gmail SMTP notifier (App Password)."""

import os
import smtplib
import ssl
from email.mime.text import MIMEText
from email.utils import formatdate


def send(subject: str, body: str, to: str | None = None) -> bool:
    user = os.environ.get("GMAIL_USER")
    pw = os.environ.get("GMAIL_APP_PASSWORD")
    if not user or not pw:
        print("[gmail_notify] GMAIL_USER / GMAIL_APP_PASSWORD not set, skipped")
        return False
    # App Password に含まれるスペースを除去
    pw = pw.replace(" ", "")

    to_addr = to or user
    msg = MIMEText(body, "plain", "utf-8")
    msg["Subject"] = subject
    msg["From"] = user
    msg["To"] = to_addr
    msg["Date"] = formatdate(localtime=True)

    ctx = ssl.create_default_context()
    try:
        with smtplib.SMTP("smtp.gmail.com", 587, timeout=15) as s:
            s.starttls(context=ctx)
            s.login(user, pw)
            s.sendmail(user, [to_addr], msg.as_string())
        return True
    except Exception as e:
        print(f"[gmail_notify] failed: {e}")
        return False
