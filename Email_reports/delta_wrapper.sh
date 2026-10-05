#!/bin/bash

BASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SMARTHUB_ROOT="$(cd "$BASE_DIR/.." && pwd)"
VENV_PATH="${VENV_PATH:-$SMARTHUB_ROOT/backend/venv}"
BACKEND_HOST="https://awsbjvnval002.jnj.com:8000"
API_KEY_FILE="${API_KEY_FILE:-$BASE_DIR/.api_key}"
API_KEY="${SMARTHUB_API_KEY:-}"
if [ -z "$API_KEY" ] && [ -f "$API_KEY_FILE" ]; then
    API_KEY=$(tr -d '\r\n' < "$API_KEY_FILE")
fi
REPORTS_DIR="$BASE_DIR/reports"
ARCHIVE_DIR="$REPORTS_DIR/archive"

SENDER="donotreply@gra-smarthub-dqe.jnj.com"

# Who gets the report itself (the xlsx attachment)
REPORT_TO="email_id,email_id"
REPORT_CC="email_id,email_id"

# Who gets the pipeline run log - usually just the support/dev folks
LOG_TO="email_id,email_id"
LOG_CC="email_id,email_id"

LOG_FILE="$BASE_DIR/logs/run_$(date '+%Y%m%d_%H%M%S').log"
mkdir -p "$BASE_DIR/logs"
exec > >(tee -a "$LOG_FILE") 2>&1

echo "=== Starting SmartHub Pipeline: $(date) ==="

# -- Mail the run log on the way out, no matter how we exit --------------------
send_log() {
    local status=$?
    echo "=== Pipeline finished with status $status: $(date) ==="
    sleep 1   # let tee flush
    python3 - "$LOG_FILE" "$status" <<PYEOF || echo "WARN: could not send run log email."
import sys, smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

log_file, status = sys.argv[1], sys.argv[2]
with open(log_file) as f:
    log = f.read()

sender   = "$SENDER"
to_addrs = [a for a in "$LOG_TO".split(",") if a]
cc_addrs = [a for a in "$LOG_CC".split(",") if a]

msg = MIMEMultipart()
msg["From"]    = sender
msg["To"]      = ", ".join(to_addrs)
if cc_addrs:
    msg["Cc"]  = ", ".join(cc_addrs)
msg["Subject"] = "DQE Biweekly Report - Pipeline Run Log (%s)" % (
    "SUCCESS" if status == "0" else "FAILED"
)
msg.attach(MIMEText(
    "<html><body><pre style='font-family:monospace;font-size:13px;'>%s</pre></body></html>" % log,
    "html",
))

with smtplib.SMTP("localhost") as server:
    server.sendmail(sender, to_addrs + cc_addrs, msg.as_string())
print("Log email sent.")
PYEOF
    exit $status
}
trap send_log EXIT

# -- Create venv if it doesn't exist ------------------------------------------
if [ ! -d "$VENV_PATH" ]; then
    echo "Creating venv at $VENV_PATH..."
    if ! python3 -m venv "$VENV_PATH"; then
        echo "FAILED: could not create venv at $VENV_PATH."
        echo "Check the path, or re-run with VENV_PATH=/some/writable/path"
        exit 1
    fi
else
    echo "Venv already exists, skipping creation."
fi

# -- Activate venv -------------------------------------------------------------
echo "Activating venv..."
source "$VENV_PATH/bin/activate"

# -- Change directory & install dependencies -----------------------------------
echo "Changing directory..."
cd "$BASE_DIR" || { echo "FAILED: cannot cd to $BASE_DIR"; exit 1; }

echo "Installing requirements..."
if ! pip install -r requirements.txt --quiet; then
    echo "FAILED: pip install failed. Aborting."
    exit 1
fi

# -- Run BDC validation (all rules) before generating delta report -------------
echo "Running BDC validation (EXECUTE_ALLRULES_DELTA) on ${BACKEND_HOST}..."

if [ -z "$API_KEY" ]; then
    echo "FAILED: no API key. Set SMARTHUB_API_KEY or create $API_KEY_FILE"
    exit 1
fi

VALIDATION_URL="${BACKEND_HOST}/api/run-validation?mode=EXECUTE_ALLRULES_DELTA"

# One python process reads the whole SSE stream instead of three per line.
curl -sN --max-time 36000 -H "X-API-Key: $API_KEY" "$VALIDATION_URL" | python3 -u -c '
import sys, json
rc = -1
for line in sys.stdin:
    line = line.strip()
    if not line.startswith("data:"):
        continue
    try:
        d = json.loads(line[5:].strip())
    except ValueError:
        continue
    if d.get("message"):
        print("[VALIDATION]", d["message"])
    if d.get("type") == "done":
        rc = d.get("returncode", -1)
        break
sys.exit(0 if rc == 0 else 1)
'
VALIDATION_RETURNCODE=${PIPESTATUS[1]}

if [ "$VALIDATION_RETURNCODE" != "0" ]; then
    echo "FAILED: BDC validation failed. Aborting delta report."
    exit 1
fi

echo "BDC validation completed successfully."

# -- Run Python script ---------------------------------------------------------
echo "Running Email_delta_report.py..."
if ! python Email_delta_report.py; then
    echo "FAILED: Email_delta_report.py exited non-zero."
    exit 1
fi

# -- Detect output report ------------------------------------------------------
echo "Checking for delta report..."
mkdir -p "$ARCHIVE_DIR"

# Newest first, so a leftover older report never gets mailed by mistake.
# Covers both: Bi_weekly_report_First_run_*.xlsx and Bi_weekly_report_*_to_*.xlsx
ATTACHMENT=$(ls -t "$REPORTS_DIR"/Bi_weekly_report_*.xlsx 2>/dev/null | head -1)

if [ -z "$ATTACHMENT" ]; then
    echo "FAILED: No delta report found in $REPORTS_DIR!"
    exit 1
fi

echo "Found report: $ATTACHMENT"

# -- Parse dates from filename for subject -------------------------------------
# Filename format: Bi_weekly_report_01_May_2026_to_20_May_2026.xlsx
REPORT_FILENAME=$(basename "$ATTACHMENT" .xlsx)
REPORT_BODY="${REPORT_FILENAME#Bi_weekly_report_}"

_parse_date() {
    # Takes a token like "01_May_2026" and returns "01 May 2026"
    echo "$1" | tr '_' ' '
}

if [[ "$REPORT_BODY" == First_run_* ]]; then
    TO_DATE=$(_parse_date "${REPORT_BODY#First_run_}")
    EMAIL_SUBJECT="DQE RTE Bi-Weekly Delta Report: $TO_DATE (First Run)"
    EMAIL_BODY="<html><body><p>Hi everyone,</p><p>Please find the attached <b>RTE bi-weekly delta report</b> generated on <b>$TO_DATE (First Run)</b>.</p><p>Regards,<br>GRA-SmartHub</p></body></html>"
else
    FROM_DATE=$(_parse_date "${REPORT_BODY%%_to_*}")
    TO_DATE=$(_parse_date "${REPORT_BODY##*_to_}")
    EMAIL_SUBJECT="DQE RTE Bi-Weekly Delta Report: $FROM_DATE to $TO_DATE"
    EMAIL_BODY="<html><body><p>Hi everyone,</p><p>Please find the attached <b>RTE bi-weekly delta report</b> generated from <b>$FROM_DATE</b> to <b>$TO_DATE</b>.</p><p>Regards,<br>GRA-SmartHub</p></body></html>"
fi

echo "Email subject: $EMAIL_SUBJECT"

# -- Send email via Python (supports HTML body + attachment) -------------------
echo "Sending email..."

python3 - "$EMAIL_SUBJECT" "$EMAIL_BODY" "$ATTACHMENT" <<PYEOF
import sys, os, smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.mime.base import MIMEBase
from email import encoders

subject, body, attachment = sys.argv[1], sys.argv[2], sys.argv[3]

sender   = "$SENDER"
to_addrs = [a for a in "$REPORT_TO".split(",") if a]
cc_addrs = [a for a in "$REPORT_CC".split(",") if a]

msg = MIMEMultipart()
msg["From"]    = sender
msg["To"]      = ", ".join(to_addrs)
if cc_addrs:
    msg["Cc"]  = ", ".join(cc_addrs)
msg["Subject"] = subject
msg.attach(MIMEText(body, "html"))

with open(attachment, "rb") as f:
    part = MIMEBase("application", "octet-stream")
    part.set_payload(f.read())
encoders.encode_base64(part)
part.add_header("Content-Disposition",
                'attachment; filename="%s"' % os.path.basename(attachment))
msg.attach(part)

with smtplib.SMTP("localhost") as server:
    server.sendmail(sender, to_addrs + cc_addrs, msg.as_string())
print("Email sent successfully.")
PYEOF

if [ $? -ne 0 ]; then
    echo "FAILED: Email send failed!"
    exit 1
fi

# -- Archive the report --------------------------------------------------------
echo "Archiving report..."
mv "$ATTACHMENT" "$ARCHIVE_DIR/$(basename "$ATTACHMENT")"
echo "Report moved to archive: $ARCHIVE_DIR/$(basename "$ATTACHMENT")"

deactivate

echo "=== Pipeline Completed Successfully: $(date) ==="