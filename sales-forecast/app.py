from flask import Flask, jsonify, send_file
from pathlib import Path
import os
from datetime import date

app = Flask(__name__)
BASE = Path(__file__).parent


@app.route("/")
def index():
    return send_file(BASE / "index.html")


@app.route("/api/pipeline")
def pipeline():
    try:
        import snowflake.connector
        from cryptography.hazmat.primitives.serialization import (
            load_pem_private_key, Encoding, PrivateFormat, NoEncryption
        )

        # Load private key — env var may use literal \n instead of real newlines
        raw_key = os.environ["SNOWFLAKE_PRIVATE_KEY"].replace("\\n", "\n").encode()
        private_key = load_pem_private_key(raw_key, password=None)
        private_key_der = private_key.private_bytes(
            encoding=Encoding.DER,
            format=PrivateFormat.PKCS8,
            encryption_algorithm=NoEncryption(),
        )

        conn_kwargs = dict(
            user=os.environ["SNOWFLAKE_USERNAME"],
            account=os.environ["SNOWFLAKE_ACCOUNT"],
            private_key=private_key_der,
            warehouse=os.environ.get("SNOWFLAKE_WAREHOUSE", "PROD_ADHOC_WH"),
            database=os.environ.get("SNOWFLAKE_DATABASE", "PROD"),
            schema="SALESFORCE",
            login_timeout=30,
        )
        role = os.environ.get("SNOWFLAKE_ROLE")
        if role:
            conn_kwargs["role"] = role

        conn = snowflake.connector.connect(**conn_kwargs)
        cur = conn.cursor()
        cur.execute("""
            SELECT
                OPPORTUNITY_ID,
                ACCOUNT_NAME,
                STAGE_NAME,
                COALESCE(RVP_FORECAST_OVERRIDE, '')               AS RVP_FORECAST_OVERRIDE,
                TO_CHAR(LAST_STAGE_CHANGE_DT::DATE,'YYYY-MM-DD') AS LAST_STAGE_CHG,
                TO_CHAR(CREATED_DTT::DATE,        'YYYY-MM-DD')  AS CREATED_DATE,
                TO_CHAR(CLOSE_DT::DATE,           'YYYY-MM-DD')  AS CLOSE_DATE,
                SFDC_TYPE                                         AS TYPE,
                COALESCE(OWNER_NAME,  '')                         AS OWNER_NAME,
                COALESCE(TERRITORY,   '')                         AS TERRITORY,
                COALESCE(PRODUCT_ARR, 0)::INT                     AS PRODUCT_ARR,
                COALESCE(SERVICES_ARR,0)::INT                     AS SERVICES_ARR,
                COALESCE(PUSH_CNT,    0)::INT                     AS PUSH_CNT,
                DATEDIFF('day', CREATED_DTT,          CURRENT_DATE())::INT AS DAYS_OPEN,
                DATEDIFF('day', LAST_STAGE_CHANGE_DT, CURRENT_DATE())::INT AS DAYS_IN_STAGE,
                CASE
                    WHEN MONTH(CLOSE_DT) = 1  THEN CONCAT(YEAR(CLOSE_DT),   'Q4')
                    WHEN MONTH(CLOSE_DT) <= 4 THEN CONCAT(YEAR(CLOSE_DT)+1, 'Q1')
                    WHEN MONTH(CLOSE_DT) <= 7 THEN CONCAT(YEAR(CLOSE_DT)+1, 'Q2')
                    WHEN MONTH(CLOSE_DT) <=10 THEN CONCAT(YEAR(CLOSE_DT)+1, 'Q3')
                    ELSE                           CONCAT(YEAR(CLOSE_DT)+1, 'Q4')
                END AS CLOSE_QTR
            FROM PROD.SALESFORCE.COALESCED_OPPORTUNITIES
            WHERE IS_CLOSED = FALSE
              AND STAGE_NAME NOT IN ('Closed Won', 'Closed Lost')
              AND SFDC_TYPE   NOT IN ('Renewal', 'Pilot', 'Renewal + Upsell')
            ORDER BY CLOSE_DT, ACCOUNT_NAME
        """)
        rows = cur.fetchall()
        conn.close()

        data = [
            [
                r[0] or "", r[1] or "", r[2] or "", r[3] or "",
                r[4] or "", r[5] or "", r[6] or "", r[7] or "",
                r[8] or "", r[9] or "",
                int(r[10] or 0), int(r[11] or 0), int(r[12] or 0),
                int(r[13] or 0),
                int(r[14]) if r[14] is not None else None,
                r[15] or "",
            ]
            for r in rows
        ]

        resp = jsonify({"data": data, "fetched_at": str(date.today()), "count": len(data)})
        resp.headers["Cache-Control"] = "no-store"
        return resp

    except Exception as exc:
        import traceback
        return jsonify({"error": str(exc), "detail": traceback.format_exc()}), 500
