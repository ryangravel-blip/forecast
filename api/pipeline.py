from http.server import BaseHTTPRequestHandler
import json
import os
from datetime import date


class handler(BaseHTTPRequestHandler):

    def do_GET(self):
        try:
            import snowflake.connector

            conn = snowflake.connector.connect(
                user=os.environ["SNOWFLAKE_USER"],
                password=os.environ["SNOWFLAKE_PASSWORD"],
                account=os.environ["SNOWFLAKE_ACCOUNT"],
                warehouse=os.environ.get("SNOWFLAKE_WAREHOUSE", "PROD_ADHOC_WH"),
                database="PROD",
                schema="SALESFORCE",
                login_timeout=30,
            )
            cur = conn.cursor()
            cur.execute("""
                SELECT
                    OPPORTUNITY_ID,
                    ACCOUNT_NAME,
                    STAGE_NAME,
                    COALESCE(RVP_FORECAST_OVERRIDE, '')           AS RVP_FORECAST_OVERRIDE,
                    TO_CHAR(LAST_STAGE_CHANGE_DT::DATE,'YYYY-MM-DD') AS LAST_STAGE_CHG,
                    TO_CHAR(CREATED_DTT::DATE,        'YYYY-MM-DD') AS CREATED_DATE,
                    TO_CHAR(CLOSE_DT::DATE,           'YYYY-MM-DD') AS CLOSE_DATE,
                    SFDC_TYPE                                      AS TYPE,
                    COALESCE(OWNER_NAME,  '')                      AS OWNER_NAME,
                    COALESCE(TERRITORY,   '')                      AS TERRITORY,
                    COALESCE(PRODUCT_ARR, 0)::INT                  AS PRODUCT_ARR,
                    COALESCE(SERVICES_ARR,0)::INT                  AS SERVICES_ARR,
                    COALESCE(PUSH_CNT,    0)::INT                  AS PUSH_CNT,
                    DATEDIFF('day', CREATED_DTT,       CURRENT_DATE())::INT AS DAYS_OPEN,
                    DATEDIFF('day', LAST_STAGE_CHANGE_DT, CURRENT_DATE())::INT AS DAYS_IN_STAGE,
                    CASE
                        WHEN MONTH(CLOSE_DT) = 1       THEN CONCAT(YEAR(CLOSE_DT),    'Q4')
                        WHEN MONTH(CLOSE_DT) <= 4      THEN CONCAT(YEAR(CLOSE_DT)+1,  'Q1')
                        WHEN MONTH(CLOSE_DT) <= 7      THEN CONCAT(YEAR(CLOSE_DT)+1,  'Q2')
                        WHEN MONTH(CLOSE_DT) <= 10     THEN CONCAT(YEAR(CLOSE_DT)+1,  'Q3')
                        ELSE                                CONCAT(YEAR(CLOSE_DT)+1,  'Q4')
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
                    r[0] or "",   # opp_id
                    r[1] or "",   # account
                    r[2] or "",   # stage
                    r[3] or "",   # rvp_override
                    r[4] or "",   # last_stage_chg
                    r[5] or "",   # created_date
                    r[6] or "",   # close_date
                    r[7] or "",   # type
                    r[8] or "",   # owner
                    r[9] or "",   # territory
                    int(r[10] or 0),  # product_arr
                    int(r[11] or 0),  # services_arr
                    int(r[12] or 0),  # push_cnt
                    int(r[13] or 0),  # days_open
                    int(r[14]) if r[14] is not None else None,  # days_in_stage
                    r[15] or "",  # close_qtr
                ]
                for r in rows
            ]

            body = json.dumps({
                "data": data,
                "fetched_at": str(date.today()),
                "count": len(data),
            })
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(body.encode())

        except Exception as exc:
            self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": str(exc)}).encode())

    def log_message(self, *args):
        pass  # suppress request logs
