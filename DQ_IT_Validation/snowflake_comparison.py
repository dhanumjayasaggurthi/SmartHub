import snowflake.connector
from cryptography.hazmat.backends import default_backend
from cryptography.hazmat.primitives import serialization
from datetime import datetime
import json
import sys
import argparse
from typing import Dict, List, Optional, Tuple
from concurrent.futures import ThreadPoolExecutor, as_completed
from threading import Lock, Thread
import time
import traceback as tb

# Global console lock for clean output
console_lock = Lock()


def print_safe(*args, **kwargs):
    """Thread-safe print function"""
    with console_lock:
        print(*args, **kwargs)


def print_header(text: str, char: str = "=", width: int = 80):
    """Print formatted header"""
    print_safe(f"\n{char * width}")
    print_safe(f"{text.center(width)}")
    print_safe(f"{char * width}")


def log_detailed_error(context: str, error: Exception, additional_info: Dict = None):
    """Log detailed error information"""
    print_safe(f"\n{'=' * 80}")
    print_safe(f"❌ ERROR: {context}")
    print_safe(f"{'=' * 80}")
    print_safe(f"Error: {str(error)}")
    if additional_info:
        print_safe(f"\nDetails:")
        for key, value in additional_info.items():
            print_safe(f"  • {key}: {value}")
    print_safe(f"{'=' * 80}\n")


def load_snowflake_layer_config(config: dict, layer: str) -> dict:
    """Load Snowflake config for a given layer ('l0' or 'l1').

    Schema discovery is dynamic (multi-schema mode) — no 'schema' field required.

    Auth types supported:
      - 'keypair'         : requires private_key_path and private_key_password
      - 'externalbrowser' : opens a browser SSO prompt; no key fields needed

    L1-specific fields:
      - 'schema_prefix'   : prefix prepended to each L0 schema name to derive the L1 schema
                             e.g. L0 schema 'insight_7' + prefix 'l1_' → 'l1_insight_7'
      - 'table_suffix'    : optional suffix appended to each L0 table name (default '')
    """
    if layer not in config:
        raise ValueError(f"{layer.upper()} configuration not found in config file")

    layer_config = config[layer]
    auth_type = layer_config.get('auth_type', 'keypair').lower()

    if auth_type not in ('keypair', 'externalbrowser'):
        raise ValueError(
            f"{layer.upper()} auth_type must be 'keypair' or 'externalbrowser', got: '{auth_type}'"
        )

    # Fields required regardless of auth type (schema is now dynamic)
    base_required = ['account', 'user', 'role', 'warehouse', 'database']
    for field in base_required:
        if field not in layer_config:
            raise ValueError(f"Required {layer.upper()} config field missing: {field}")

    if auth_type == 'keypair':
        for field in ('private_key_path', 'private_key_password'):
            if field not in layer_config:
                raise ValueError(
                    f"{layer.upper()} auth_type is 'keypair' but '{field}' is missing"
                )

    result = {
        'account':              layer_config['account'],
        'user':                 layer_config['user'],
        'role':                 layer_config['role'],
        'warehouse':            layer_config['warehouse'],
        'database':             layer_config['database'],
        'auth_type':            auth_type,
        'private_key_path':     layer_config.get('private_key_path'),
        'private_key_password': layer_config.get('private_key_password'),
    }

    if layer == 'l1':
        result['schema_prefix'] = layer_config.get('schema_prefix', '')
        # table_suffix is now auto-derived per schema from the schema name — not set in config

    return result


def load_snowflake_save_config(config: dict) -> dict:
    """Load Snowflake Save configuration for saving validation reports.
    Supports both 'keypair' and 'externalbrowser' auth types.
    """
    if 'snowflake_save' not in config:
        raise ValueError("Snowflake Save configuration not found in config file")

    sf_config = config['snowflake_save']
    auth_type = sf_config.get('auth_type', 'keypair').lower()

    base_required = ['account', 'user', 'role', 'warehouse', 'database', 'stg_schema', 'core_schema']
    for field in base_required:
        if field not in sf_config:
            raise ValueError(f"Required Snowflake Save config field missing: {field}")

    if auth_type == 'keypair':
        for field in ('private_key_path', 'private_key_password'):
            if field not in sf_config:
                raise ValueError(f"snowflake_save auth_type is 'keypair' but '{field}' is missing")

    return {
        'account':              sf_config['account'],
        'user':                 sf_config['user'],
        'role':                 sf_config['role'],
        'warehouse':            sf_config['warehouse'],
        'database':             sf_config['database'],
        'stg_schema':           sf_config['stg_schema'],
        'core_schema':          sf_config['core_schema'],
        'auth_type':            auth_type,
        'private_key_path':     sf_config.get('private_key_path'),
        'private_key_password': sf_config.get('private_key_password'),
    }


def get_private_key(path: str, password: str):
    """Load private key for Snowflake authentication"""
    with open(path, "rb") as key_file:
        p_key = serialization.load_pem_private_key(
            key_file.read(),
            password=password.encode(),
            backend=default_backend()
        )
    return p_key.private_bytes(
        encoding=serialization.Encoding.DER,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption()
    )


def create_snowflake_connection(sf_config: dict):
    """Create a simple Snowflake connection (used for report saving).
    Supports 'keypair' and 'externalbrowser' auth types.
    """
    try:
        auth_type = sf_config.get('auth_type', 'keypair').lower()
        conn_params = {
            'user':      sf_config['user'],
            'account':   sf_config['account'],
            'role':      sf_config['role'],
            'warehouse': sf_config['warehouse'],
        }
        if sf_config.get('database'):
            conn_params['database'] = sf_config['database']

        if auth_type == 'externalbrowser':
            print_safe("      🌐 External browser authentication required for save connection — check your browser...")
            conn_params['authenticator'] = 'externalbrowser'
        else:
            private_key = get_private_key(sf_config['private_key_path'], sf_config['private_key_password'])
            conn_params['private_key'] = private_key

        return snowflake.connector.connect(**conn_params)
    except FileNotFoundError as e:
        print_safe(f"❌ Private key file not found: {e}")
        raise
    except Exception as e:
        print_safe(f"❌ Snowflake connection failed: {e}")
        raise
    except Exception as e:
        print_safe(f"❌ Snowflake connection failed: {e}")
        raise


def create_schemas_if_not_exist(conn, stg_schema: str, core_schema: str):
    """Create STG and CORE schemas if they don't exist"""
    try:
        cur = conn.cursor()
        cur.execute(f"CREATE SCHEMA IF NOT EXISTS {stg_schema}")
        cur.execute(f"CREATE SCHEMA IF NOT EXISTS {core_schema}")
        cur.close()
    except Exception as e:
        print_safe(f"❌ Failed to create schemas: {e}")
        raise


def create_core_table_if_not_exists(conn, core_schema: str):
    """Create CORE validation_report table if it doesn't exist"""
    try:
        cur = conn.cursor()
        table_name = f"{core_schema}.DQ_IT_VALIDATION_REPORT"
        cur.execute(f"""
            CREATE TABLE IF NOT EXISTS {table_name} (
                report_data VARIANT NOT NULL,
                run_timestamp TIMESTAMP_NTZ NOT NULL,
                load_date TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()
            )
        """)
        cur.close()
    except Exception as e:
        print_safe(f"❌ Failed to create CORE table: {e}")
        raise


def save_report_to_snowflake(consolidated_report: dict, sf_config: dict):
    """
    Save validation report to Snowflake with STG and CORE pattern.

    STG: Creates new timestamped table for each run (historical archive)
    CORE: Truncates and loads latest data (only if all validations passed)
    """
    conn = None
    try:
        conn = create_snowflake_connection(sf_config)
        create_schemas_if_not_exist(conn, sf_config['stg_schema'], sf_config['core_schema'])
        create_core_table_if_not_exists(conn, sf_config['core_schema'])

        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        stg_table_name = f"{sf_config['stg_schema']}.DQ_IT_VALIDATION_REPORT_{timestamp}"
        run_timestamp = consolidated_report.get('report_metadata', {}).get('generated_timestamp')

        cur = conn.cursor()

        # Create STG table and insert
        cur.execute(f"""
            CREATE TABLE {stg_table_name} (
                report_data VARIANT NOT NULL,
                run_timestamp TIMESTAMP_NTZ NOT NULL,
                load_date TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()
            )
        """)

        report_json = json.dumps(consolidated_report, indent=2)
        cur.execute(f"""
            INSERT INTO {stg_table_name} (report_data, run_timestamp)
            SELECT PARSE_JSON(%s), TO_TIMESTAMP_NTZ(%s)
        """, (report_json, run_timestamp))

        print_safe(f"✅ Snowflake: Saved to {stg_table_name}")

        # Update CORE only if there are no failures
        failed_runs = consolidated_report.get('overall_summary', {}).get('failed_runs', 0)
        if failed_runs == 0:
            core_table_name = f"{sf_config['core_schema']}.DQ_IT_VALIDATION_REPORT"
            cur.execute(f"TRUNCATE TABLE {core_table_name}")
            cur.execute(f"""
                INSERT INTO {core_table_name} (report_data, run_timestamp)
                SELECT PARSE_JSON(%s), TO_TIMESTAMP_NTZ(%s)
            """, (report_json, run_timestamp))
            print_safe(f"✅ Snowflake: Updated {core_table_name}")
        else:
            print_safe(f"⚠️  Snowflake: CORE not updated (validation had {failed_runs} failed run(s))")

        cur.close()
    except Exception as e:
        print_safe(f"❌ Snowflake save failed: {e}")
        raise
    finally:
        if conn:
            conn.close()


class ConnectionPool:
    """Thread-safe connection pool for parallel execution"""

    def __init__(self, connector_class, connection_params: dict, max_connections: int = 5):
        self.connector_class = connector_class
        self.connection_params = connection_params
        self.max_connections = max_connections
        self.connections = []
        self.available = []
        self.lock = Lock()
        self.keepalive_interval = 300  # Ping every 5 minutes
        self.keepalive_thread = None
        self.keepalive_running = False
        self._start_keepalive()

    def _start_keepalive(self):
        self.keepalive_running = True
        self.keepalive_thread = Thread(target=self._keepalive_worker, daemon=True)
        self.keepalive_thread.start()

    def _keepalive_worker(self):
        check_interval = 1
        elapsed = 0
        while self.keepalive_running:
            time.sleep(check_interval)
            elapsed += check_interval
            if elapsed >= self.keepalive_interval:
                elapsed = 0
                with self.lock:
                    for conn in self.connections:
                        try:
                            if hasattr(conn, 'last_activity') and conn.last_activity:
                                idle_time = time.time() - conn.last_activity
                                if idle_time > 240:
                                    conn.is_alive()
                        except:
                            pass

    def get_connection(self, max_wait_seconds: int = 30):
        """Get an available connection or create a new one, with health validation"""
        start_time = time.time()

        while True:
            with self.lock:
                while self.available:
                    conn = self.available.pop()
                    if conn.is_alive():
                        return conn
                    else:
                        if conn.reconnect():
                            return conn
                        else:
                            try:
                                self.connections.remove(conn)
                            except ValueError:
                                pass

                if len(self.connections) < self.max_connections:
                    try:
                        conn = self.connector_class(**self.connection_params)
                        if conn.connect():
                            self.connections.append(conn)
                            return conn
                        else:
                            log_detailed_error(
                                "Connection Pool - Failed to connect",
                                Exception("Connection attempt returned False"),
                                {"Connector": self.connector_class.__name__}
                            )
                            return None
                    except Exception as e:
                        log_detailed_error(
                            "Connection Pool - Exception during connection",
                            e,
                            {"Connector": self.connector_class.__name__,
                             "Connection Params": {k: v for k, v in self.connection_params.items()
                                                   if k not in ['private_key_password']}}
                        )
                        return None

            elapsed = time.time() - start_time
            if elapsed >= max_wait_seconds:
                log_detailed_error(
                    "Connection Pool Exhausted",
                    Exception(f"No connections available after {max_wait_seconds}s"),
                    {
                        "Connector": self.connector_class.__name__,
                        "Total Connections": len(self.connections),
                        "Available": len(self.available),
                        "Max Connections": self.max_connections,
                        "Waited": f"{elapsed:.1f}s"
                    }
                )
                return None

            time.sleep(0.1)

    def return_connection(self, conn):
        """Return connection to pool"""
        with self.lock:
            if conn and conn not in self.available:
                self.available.append(conn)

    def close_all(self, force_skip_disconnect=False):
        """Close all connections and stop keepalive thread"""
        self.keepalive_running = False
        if self.keepalive_thread:
            self.keepalive_thread.join(timeout=3)

        with self.lock:
            if force_skip_disconnect:
                print_safe("      ⚠️  Skipping connection disconnect (abandoned threads detected)")
                self.connections.clear()
                self.available.clear()
            else:
                for conn in self.connections:
                    try:
                        conn.disconnect()
                    except:
                        pass
                self.connections.clear()
                self.available.clear()


class SnowflakeConnector:
    """Snowflake connector supporting key-pair and external browser authentication"""

    def __init__(self, account: str, user: str, role: str, warehouse: str,
                 database: str, schema: str = None,
                 auth_type: str = 'keypair',
                 private_key_path: str = None, private_key_password: str = None,
                 **kwargs):  # absorb extra config keys (e.g. schema_prefix, table_suffix)
        self.account = account
        self.user = user
        self.role = role
        self.warehouse = warehouse
        self.database = database
        self.schema = schema  # may be None for discovery connections
        self.auth_type = auth_type.lower()
        self.private_key_path = private_key_path
        self.private_key_password = private_key_password
        self.conn = None
        self.last_activity = None

    def connect(self):
        """Establish Snowflake connection using the configured auth type"""
        try:
            base_params = {
                'user':      self.user,
                'account':   self.account,
                'warehouse': self.warehouse,
                'database':  self.database,
                'schema':    self.schema,
                'role':      self.role,
            }

            if self.auth_type == 'externalbrowser':
                # Opens a browser window for SSO/MFA authentication
                print_safe(
                    f"      🌐 External browser authentication required for "
                    f"{self.database}.{self.schema} — check your browser..."
                )
                self.conn = snowflake.connector.connect(
                    **base_params,
                    authenticator='externalbrowser'
                )
            else:
                # Key-pair authentication
                with open(self.private_key_path, 'rb') as key_file:
                    p_key = serialization.load_pem_private_key(
                        key_file.read(),
                        password=self.private_key_password.encode(),
                        backend=default_backend()
                    )
                pkb = p_key.private_bytes(
                    encoding=serialization.Encoding.DER,
                    format=serialization.PrivateFormat.PKCS8,
                    encryption_algorithm=serialization.NoEncryption()
                )
                self.conn = snowflake.connector.connect(**base_params, private_key=pkb)

            self.last_activity = time.time()
            return True

        except Exception as e:
            info = {
                "Account":   self.account,
                "User":      self.user,
                "Role":      self.role,
                "Warehouse": self.warehouse,
                "Database":  self.database,
                "Schema":    self.schema,
                "Auth Type": self.auth_type,
            }
            if self.auth_type == 'keypair':
                info["Private Key Path"] = self.private_key_path
            log_detailed_error("Snowflake Connection Failed", e, info)
            return False

    def is_alive(self) -> bool:
        """Check if connection is still alive"""
        if not self.conn:
            return False
        try:
            cursor = self.conn.cursor()
            cursor.execute("SELECT 1")
            cursor.fetchone()
            cursor.close()
            self.last_activity = time.time()
            return True
        except:
            return False

    def reconnect(self) -> bool:
        """Reconnect to Snowflake"""
        try:
            self.disconnect()
        except:
            pass
        return self.connect()

    def ensure_connected(self) -> bool:
        """Ensure connection is alive, reconnect if needed"""
        if not self.is_alive():
            print_safe(f"      ⚠️  Snowflake connection lost, reconnecting...")
            if self.reconnect():
                print_safe(f"      ✓ Snowflake reconnected successfully")
                return True
            else:
                print_safe(f"      ✗ Snowflake reconnection failed")
                return False
        return True

    def disconnect(self):
        if self.conn:
            try:
                self.conn.close()
            except:
                pass
        self.conn = None

    def table_exists(self, table_name: str) -> bool:
        """Check if table exists with retry logic. Logs real errors instead of silently returning False."""
        max_retries = 3
        for attempt in range(max_retries):
            try:
                if not self.ensure_connected():
                    if attempt < max_retries - 1:
                        time.sleep(2 ** attempt)
                        continue
                    print_safe(
                        f"      ✗ table_exists: could not connect to "
                        f"{self.database}.{self.schema} to check '{table_name}'"
                    )
                    return False
                cursor = self.conn.cursor()
                cursor.execute(f"""
                    SELECT COUNT(*)
                    FROM "{self.database}".INFORMATION_SCHEMA.TABLES
                    WHERE UPPER(TABLE_SCHEMA) = %s
                    AND UPPER(TABLE_NAME) = %s
                """, (self.schema.upper(), table_name.upper()))
                count = cursor.fetchone()[0]
                cursor.close()
                self.last_activity = time.time()
                return count > 0
            except Exception as e:
                print_safe(
                    f"      ⚠️  table_exists error (attempt {attempt + 1}/{max_retries}) "
                    f"— DB: {self.database}, Schema: {self.schema}, Table: {table_name} → {e}"
                )
                if attempt < max_retries - 1:
                    time.sleep(2 ** attempt)
                    continue
                return False

    def get_all_schemas(self, exclude_system: bool = True) -> List[str]:
        """Auto-discover all user schemas in the database (database-level connection)."""
        system_schemas = {
            'INFORMATION_SCHEMA', 'PUBLIC', 'ACCOUNT_USAGE', 'SNOWFLAKE'
        }
        max_retries = 3
        for attempt in range(max_retries):
            try:
                if not self.ensure_connected():
                    if attempt < max_retries - 1:
                        time.sleep(2 ** attempt)
                        continue
                    raise Exception("Failed to establish Snowflake connection after retries")
                cursor = self.conn.cursor()
                cursor.execute(f"""
                    SELECT SCHEMA_NAME
                    FROM "{self.database}".INFORMATION_SCHEMA.SCHEMATA
                    ORDER BY SCHEMA_NAME
                """)
                schemas = [row[0] for row in cursor.fetchall()]
                cursor.close()
                self.last_activity = time.time()
                if exclude_system:
                    schemas = [s for s in schemas if s.upper() not in system_schemas]
                return schemas
            except Exception as e:
                if attempt < max_retries - 1:
                    time.sleep(2 ** attempt)
                    continue
                log_detailed_error(
                    "Snowflake - Failed to retrieve schema list",
                    e,
                    {"Database": self.database}
                )
                raise

    def get_all_tables(self) -> List[str]:
        """Auto-discover all base tables in the schema"""
        max_retries = 3
        for attempt in range(max_retries):
            try:
                if not self.ensure_connected():
                    if attempt < max_retries - 1:
                        time.sleep(2 ** attempt)
                        continue
                    raise Exception("Failed to establish Snowflake connection after retries")
                cursor = self.conn.cursor()
                cursor.execute(f"""
                    SELECT TABLE_NAME
                    FROM "{self.database}".INFORMATION_SCHEMA.TABLES
                    WHERE UPPER(TABLE_SCHEMA) = %s
                    AND TABLE_TYPE = 'BASE TABLE'
                    ORDER BY TABLE_NAME
                """, (self.schema.upper(),))
                tables = [row[0] for row in cursor.fetchall()]
                cursor.close()
                self.last_activity = time.time()
                if not tables:
                    print_safe(f"⚠️  WARNING: No tables found in L0 {self.database}.{self.schema}")
                return tables
            except Exception as e:
                if attempt < max_retries - 1:
                    time.sleep(2 ** attempt)
                    continue
                log_detailed_error(
                    "Snowflake - Failed to retrieve table list",
                    e,
                    {"Database": self.database, "Schema": self.schema}
                )
                raise

    def get_columns(self, table_name: str) -> List[Dict]:
        """Get columns for a table with retry logic"""
        max_retries = 3
        for attempt in range(max_retries):
            try:
                if not self.ensure_connected():
                    if attempt < max_retries - 1:
                        time.sleep(2 ** attempt)
                        continue
                    raise Exception("Failed to establish Snowflake connection after retries")
                cursor = self.conn.cursor()
                cursor.execute(f'DESCRIBE TABLE "{self.database}"."{self.schema}"."{table_name}"')
                columns = []
                for row in cursor.fetchall():
                    columns.append({
                        'name': row[0],
                        'type': row[1],
                        'nullable': row[3] == 'Y'
                    })
                cursor.close()
                self.last_activity = time.time()

                if not columns:
                    error_msg = f"Table {table_name} not found in {self.database}.{self.schema}"
                    log_detailed_error(
                        "Snowflake - Table Not Found",
                        Exception(error_msg),
                        {"Table": table_name, "Database": self.database, "Schema": self.schema, "Role": self.role}
                    )
                    raise Exception(error_msg)
                return columns
            except Exception as e:
                error_str = str(e)
                if "not connected" in error_str.lower() and attempt < max_retries - 1:
                    print_safe(f"      ⚠️  Connection error on attempt {attempt + 1}, retrying...")
                    time.sleep(2 ** attempt)
                    continue
                if "not found" not in error_str.lower():
                    log_detailed_error(
                        f"Snowflake - Failed to retrieve columns for table {table_name}",
                        e,
                        {"Table": table_name, "Database": self.database, "Schema": self.schema, "Attempt": attempt + 1}
                    )
                raise

    def get_constraints(self, table_name: str) -> Dict:
        """Get all constraints for a table using DESCRIBE TABLE"""
        constraints = {
            'primary_keys': [],
            'unique_constraints': [],
            'check_constraints': [],
            'not_null_columns': [],
            'foreign_keys': []
        }
        try:
            cursor = self.conn.cursor()
            cursor.execute(f'DESCRIBE TABLE "{self.database}"."{self.schema}"."{table_name}"')
            describe_results = cursor.fetchall()

            for row in describe_results:
                column_name = row[0]
                is_nullable = row[3]
                is_primary_key = row[5]
                is_unique_key = row[6]
                check_constraint = row[7] if len(row) > 7 else None

                if is_primary_key == 'Y':
                    constraints['primary_keys'].append(column_name)
                if is_unique_key == 'Y':
                    constraints['unique_constraints'].append(
                        {'name': f'UNIQUE_{column_name}', 'columns': [column_name]}
                    )
                if is_nullable == 'N':
                    constraints['not_null_columns'].append(column_name)
                if check_constraint:
                    constraints['check_constraints'].append(
                        {'name': f'CHECK_{column_name}', 'condition': check_constraint}
                    )

            # Get Foreign Keys
            try:
                cursor.execute(
                    f'SHOW IMPORTED KEYS IN TABLE "{self.database}"."{self.schema}"."{table_name}"'
                )
                fk_results = cursor.fetchall()
                fk_dict = {}
                for row in fk_results:
                    if len(row) >= 10:
                        fk_name = row[9] if row[9] else f"FK_{row[7]}"
                        fk_column = row[7]
                        pk_table = row[2]
                        pk_column = row[3]
                        if fk_name not in fk_dict:
                            fk_dict[fk_name] = {
                                'columns': [],
                                'referenced_table': pk_table,
                                'referenced_columns': []
                            }
                        fk_dict[fk_name]['columns'].append(fk_column)
                        fk_dict[fk_name]['referenced_columns'].append(pk_column)
                constraints['foreign_keys'] = [
                    {
                        'name': n,
                        'columns': v['columns'],
                        'referenced_table': v['referenced_table'],
                        'referenced_columns': v['referenced_columns']
                    }
                    for n, v in fk_dict.items()
                ]
            except Exception:
                pass  # Table may have no FKs

            cursor.close()
        except Exception as e:
            log_detailed_error(
                f"Snowflake - Failed to get constraints for table {table_name}",
                e,
                {"Table": table_name, "Database": self.database, "Schema": self.schema}
            )
        return constraints

    def get_table_last_altered(self, table_name: str) -> Optional[str]:
        """Get the last altered timestamp for a table"""
        try:
            cursor = self.conn.cursor()
            cursor.execute(f"""
                SELECT LAST_ALTERED
                FROM "{self.database}".INFORMATION_SCHEMA.TABLES
                WHERE UPPER(TABLE_SCHEMA) = %s
                AND UPPER(TABLE_NAME) = %s
            """, (self.schema.upper(), table_name.upper()))
            result = cursor.fetchone()
            cursor.close()
            if result and result[0]:
                return result[0].isoformat()
            return None
        except Exception as e:
            print_safe(f"⚠️  Failed to get last altered time for {table_name}: {e}")
            return None


class DataValidator:
    """L0 to L1 Snowflake data validation with parallel table processing"""

    def __init__(self, l0_pool: ConnectionPool, l1_pool: ConnectionPool,
                 tables: List[str], l1_table_suffix: str = "",
                 excluded_columns: List[str] = None,
                 parallel_execution: bool = True, max_parallel_tables: int = 5,
                 table_timeout: int = 60, max_retries: int = 3):
        self.l0_pool = l0_pool
        self.l1_pool = l1_pool
        self.tables = tables
        self.l1_table_suffix = l1_table_suffix
        self.excluded_columns = [col.upper() for col in (excluded_columns or [])]
        self.parallel_execution = parallel_execution
        self.max_parallel_tables = max_parallel_tables
        self.table_timeout = table_timeout
        self.max_retries = max_retries
        self.results_lock = Lock()
        self.has_abandoned_threads = False
        self.results = {
            'metadata': {
                'validation_timestamp': datetime.now().isoformat(),
                'validation_type': 'L0 vs L1 Snowflake Validation',
                'total_tables': len(tables),
                'excluded_columns': self.excluded_columns,
                'parallel_execution': parallel_execution,
                'max_parallel_workers': max_parallel_tables if parallel_execution else 1,
                'table_timeout_seconds': table_timeout,
                'max_retries': max_retries,
                'l1_table_suffix': l1_table_suffix
            },
            'summary': {},
            'table_validations': [],
            'faulty_tables': []
        }

    def _filter_excluded_columns(self, columns: List[Dict]) -> List[Dict]:
        if not self.excluded_columns:
            return columns
        return [col for col in columns if col['name'].upper() not in self.excluded_columns]

    def _is_semi_structured(self, col_type: str) -> bool:
        """Check if a Snowflake column type cannot be used in COUNT(DISTINCT) or GROUP BY"""
        semi_types = {'VARIANT', 'OBJECT', 'ARRAY'}
        col_type_upper = col_type.upper()
        return any(t in col_type_upper for t in semi_types)

    def _get_row_counts_parallel(self, l0_conn, l1_conn, l0_table: str, l1_table: str):
        """Get row counts for both tables in parallel"""

        def get_l0_count():
            try:
                query = f'SELECT COUNT(*) FROM "{l0_conn.database}"."{l0_conn.schema}"."{l0_table}"'
                cursor = l0_conn.conn.cursor()
                cursor.execute(query)
                count = cursor.fetchone()[0]
                cursor.close()
                return count
            except Exception as e:
                log_detailed_error(f"L0 - Failed to get row count for {l0_table}", e, {"Table": l0_table})
                return None

        def get_l1_count():
            try:
                query = f'SELECT COUNT(*) FROM "{l1_conn.database}"."{l1_conn.schema}"."{l1_table}"'
                cursor = l1_conn.conn.cursor()
                cursor.execute(query)
                count = cursor.fetchone()[0]
                cursor.close()
                return count
            except Exception as e:
                log_detailed_error(f"L1 - Failed to get row count for {l1_table}", e, {"Table": l1_table})
                return None

        with ThreadPoolExecutor(max_workers=2) as executor:
            f0 = executor.submit(get_l0_count)
            f1 = executor.submit(get_l1_count)
            return f0.result(), f1.result()

    def _analyze_column_statistics(self, l0_conn, l1_conn, l0_columns: List[Dict],
                                   l1_columns: List[Dict], l0_table: str, l1_table: str):
        """Get per-column distinct counts and null counts for matching columns"""
        l0_col_map = {col['name'].upper(): col for col in l0_columns}
        l1_col_map = {col['name'].upper(): col for col in l1_columns}
        common_col_names = set(l0_col_map.keys()) & set(l1_col_map.keys())

        if not common_col_names:
            return []

        # Filter out semi-structured columns
        matched_cols = []
        skipped = []
        for name in common_col_names:
            l0_col = l0_col_map[name]
            l1_col = l1_col_map[name]
            if self._is_semi_structured(l0_col.get('type', '')) or self._is_semi_structured(l1_col.get('type', '')):
                skipped.append(f"{l0_col['name']} ({l0_col.get('type', '')})")
            else:
                matched_cols.append({'l0_col': l0_col, 'l1_col': l1_col, 'matched_name': name})

        if skipped:
            print_safe(f"     ℹ️  Skipping semi-structured columns: {', '.join(skipped[:3])}")
            if len(skipped) > 3:
                print_safe(f"        ... and {len(skipped) - 3} more")

        if not matched_cols:
            return []

        # Build combined queries for both sides
        l0_stat_parts = []
        l1_stat_parts = []
        for match in matched_cols:
            col_name = match['l0_col']['name']
            safe_alias = match['matched_name'].replace(' ', '_').replace('-', '_')
            l0_stat_parts.append(f'COUNT(DISTINCT "{col_name}") as {safe_alias}_DISTINCT')
            l0_stat_parts.append(f'SUM(CASE WHEN "{col_name}" IS NULL THEN 1 ELSE 0 END) as {safe_alias}_NULLS')
            l1_col_name = match['l1_col']['name']
            l1_stat_parts.append(f'COUNT(DISTINCT "{l1_col_name}") as {safe_alias}_DISTINCT')
            l1_stat_parts.append(f'SUM(CASE WHEN "{l1_col_name}" IS NULL THEN 1 ELSE 0 END) as {safe_alias}_NULLS')

        l0_query = f'SELECT {", ".join(l0_stat_parts)} FROM "{l0_conn.database}"."{l0_conn.schema}"."{l0_table}"'
        l1_query = f'SELECT {", ".join(l1_stat_parts)} FROM "{l1_conn.database}"."{l1_conn.schema}"."{l1_table}"'

        def run_l0_stats():
            try:
                cursor = l0_conn.conn.cursor()
                cursor.execute(l0_query)
                result = cursor.fetchone()
                cursor.close()
                return result
            except Exception as e:
                log_detailed_error(f"L0 - Failed to get column statistics for {l0_table}", e,
                                   {"Table": l0_table, "Columns": [m['matched_name'] for m in matched_cols[:5]]})
                return None

        def run_l1_stats():
            try:
                cursor = l1_conn.conn.cursor()
                cursor.execute(l1_query)
                result = cursor.fetchone()
                cursor.close()
                return result
            except Exception as e:
                log_detailed_error(f"L1 - Failed to get column statistics for {l1_table}", e,
                                   {"Table": l1_table, "Columns": [m['matched_name'] for m in matched_cols[:5]]})
                return None

        with ThreadPoolExecutor(max_workers=2) as executor:
            f0 = executor.submit(run_l0_stats)
            f1 = executor.submit(run_l1_stats)
            l0_stats_result = f0.result()
            l1_stats_result = f1.result()

        column_statistics = []
        if l0_stats_result and l1_stats_result:
            for i, match in enumerate(matched_cols):
                try:
                    l0_distinct = l0_stats_result[i * 2] if l0_stats_result[i * 2] is not None else 0
                    l0_nulls = l0_stats_result[i * 2 + 1] if l0_stats_result[i * 2 + 1] is not None else 0
                    l1_distinct = l1_stats_result[i * 2] if l1_stats_result[i * 2] is not None else 0
                    l1_nulls = l1_stats_result[i * 2 + 1] if l1_stats_result[i * 2 + 1] is not None else 0

                    column_statistics.append({
                        'column_name': match['matched_name'],
                        'l0_type': match['l0_col']['type'],
                        'l1_type': match['l1_col']['type'],
                        'l0_stats': {'distinct_count': l0_distinct, 'null_count': l0_nulls},
                        'l1_stats': {'distinct_count': l1_distinct, 'null_count': l1_nulls},
                        'stats_match': {
                            'distinct_count': l0_distinct == l1_distinct,
                            'null_count': l0_nulls == l1_nulls
                        }
                    })
                except Exception:
                    continue

        return column_statistics

    def _get_overall_null_count_parallel(self, l0_conn, l1_conn, l0_table: str, l1_table: str,
                                         l0_columns: List[Dict], l1_columns: List[Dict]):
        """Count total nulls across all common columns in parallel"""

        def count_nulls(conn, table: str, columns: List[Dict], layer: str):
            try:
                # Skip semi-structured columns in null count
                filtered = [col for col in columns if not self._is_semi_structured(col.get('type', ''))]
                if not filtered:
                    return 0
                null_checks = [f'SUM(CASE WHEN "{col["name"]}" IS NULL THEN 1 ELSE 0 END)' for col in filtered]
                query = (f'SELECT {" + ".join(null_checks)} as TOTAL_NULLS '
                         f'FROM "{conn.database}"."{conn.schema}"."{table}"')
                cursor = conn.conn.cursor()
                cursor.execute(query)
                result = cursor.fetchone()[0]
                cursor.close()
                return result if result is not None else 0
            except Exception as e:
                log_detailed_error(f"{layer} - Failed to get null count for {table}", e, {"Table": table})
                return None

        with ThreadPoolExecutor(max_workers=2) as executor:
            f0 = executor.submit(count_nulls, l0_conn, l0_table, l0_columns, "L0")
            f1 = executor.submit(count_nulls, l1_conn, l1_table, l1_columns, "L1")
            return f0.result(), f1.result()

    def _get_duplicate_count_parallel(self, l0_conn, l1_conn, l0_table: str, l1_table: str,
                                      l0_columns: List[Dict], l1_columns: List[Dict]):
        """Count duplicate rows based on all groupable columns in parallel"""

        def count_duplicates(conn, table: str, columns: List[Dict], layer: str):
            try:
                filtered_cols = [col for col in columns if not self._is_semi_structured(col.get('type', ''))]
                if not filtered_cols:
                    return 0
                col_list = ', '.join([f'"{col["name"]}"' for col in filtered_cols])
                query = f"""
                    SELECT COUNT(*) FROM (
                        SELECT {col_list}, COUNT(*) as cnt
                        FROM "{conn.database}"."{conn.schema}"."{table}"
                        GROUP BY {col_list}
                        HAVING COUNT(*) > 1
                    ) AS duplicates
                """
                cursor = conn.conn.cursor()
                cursor.execute(query)
                result = cursor.fetchone()[0]
                cursor.close()
                return result if result is not None else 0
            except Exception as e:
                log_detailed_error(f"{layer} - Failed to get duplicate count for {table}", e, {"Table": table})
                return None

        with ThreadPoolExecutor(max_workers=2) as executor:
            f0 = executor.submit(count_duplicates, l0_conn, l0_table, l0_columns, "L0")
            f1 = executor.submit(count_duplicates, l1_conn, l1_table, l1_columns, "L1")
            return f0.result(), f1.result()

    def _analyze_constraints(self, l0_conn, l1_conn, l0_table: str, l1_table: str) -> Dict:
        """Compare constraints between L0 and L1 tables"""
        constraint_counts = {
            'primary_keys': {'l0': 0, 'l1': 0},
            'foreign_keys': {'l0': 0, 'l1': 0},
            'unique_constraints': {'l0': 0, 'l1': 0},
            'check_constraints': {'l0': 0, 'l1': 0},
            'not_null_constraints': {'l0': 0, 'l1': 0}
        }

        validation_results = {
            'primary_keys': {'status': 'UNKNOWN', 'details': None},
            'unique_constraints': {'status': 'UNKNOWN', 'details': None},
            'check_constraints': {'status': 'UNKNOWN', 'details': None},
            'not_null_constraints': {'status': 'UNKNOWN', 'details': []},
            'foreign_keys': {'status': 'UNKNOWN', 'details': None}
        }

        try:
            l0_constraints = l0_conn.get_constraints(l0_table)
            l1_constraints = l1_conn.get_constraints(l1_table)

            # ==================== PRIMARY KEYS ====================
            l0_pk = set(l0_constraints['primary_keys'])
            l1_pk = set(l1_constraints['primary_keys'])
            if l0_pk == l1_pk:
                validation_results['primary_keys']['status'] = 'MATCH'
                validation_results['primary_keys']['details'] = f"Primary keys match: {list(l0_pk)}"
            else:
                validation_results['primary_keys']['status'] = 'MISMATCH'
                pk_only_l0 = l0_pk - l1_pk
                pk_only_l1 = l1_pk - l0_pk
                details = []
                if pk_only_l0:
                    constraint_counts['primary_keys']['l0'] = len(pk_only_l0)
                    details.append(f"Primary keys only in L0: {list(pk_only_l0)}")
                if pk_only_l1:
                    constraint_counts['primary_keys']['l1'] = len(pk_only_l1)
                    details.append(f"Primary keys only in L1: {list(pk_only_l1)}")
                validation_results['primary_keys']['details'] = '; '.join(details)

            # ==================== UNIQUE CONSTRAINTS ====================
            l0_uc = len(l0_constraints['unique_constraints'])
            l1_uc = len(l1_constraints['unique_constraints'])
            if l0_uc == l1_uc:
                validation_results['unique_constraints']['status'] = 'MATCH'
                validation_results['unique_constraints']['details'] = f"Unique constraint count matches: {l0_uc}"
            else:
                validation_results['unique_constraints']['status'] = 'MISMATCH'
                validation_results['unique_constraints']['details'] = (
                    f"Unique constraint mismatch: L0={l0_uc}, L1={l1_uc}"
                )
                if l0_uc > l1_uc:
                    constraint_counts['unique_constraints']['l0'] = l0_uc - l1_uc
                else:
                    constraint_counts['unique_constraints']['l1'] = l1_uc - l0_uc

            # ==================== NOT NULL CONSTRAINTS ====================
            l0_nn = set(l0_constraints['not_null_columns'])
            l1_nn = set(l1_constraints['not_null_columns'])
            nn_only_l0 = l0_nn - l1_nn
            nn_only_l1 = l1_nn - l0_nn

            if nn_only_l0:
                constraint_counts['not_null_constraints']['l0'] = len(nn_only_l0)
            if nn_only_l1:
                constraint_counts['not_null_constraints']['l1'] = len(nn_only_l1)

            # Validate actual NULL data in L1 for columns marked NOT NULL in L0
            cursor = l1_conn.conn.cursor()
            for col in l0_nn:
                try:
                    cursor.execute(f"""
                        SELECT COUNT(*) as total_rows,
                               COUNT(*) - COUNT("{col}") as null_count
                        FROM "{l1_conn.database}"."{l1_conn.schema}"."{l1_table}"
                    """)
                    result = cursor.fetchone()
                    null_count = result[1]
                    validation_results['not_null_constraints']['details'].append({
                        'column': col,
                        'exists_in_l0': True,
                        'exists_in_l1': col in l1_nn,
                        'l1_null_count': null_count,
                        'validation_status': 'PASS' if null_count == 0 else 'FAIL'
                    })
                except Exception as e:
                    validation_results['not_null_constraints']['details'].append(
                        {'column': col, 'error': str(e)}
                    )
            cursor.close()

            failed_nn = sum(
                1 for d in validation_results['not_null_constraints']['details']
                if d.get('validation_status') == 'FAIL'
            )
            if failed_nn > 0:
                validation_results['not_null_constraints']['status'] = 'VALIDATION_FAILED'
            elif nn_only_l0 or nn_only_l1:
                validation_results['not_null_constraints']['status'] = 'DEFINITION_MISMATCH'
            else:
                validation_results['not_null_constraints']['status'] = 'MATCH'

            # ==================== CHECK CONSTRAINTS ====================
            l0_cc = len(l0_constraints['check_constraints'])
            l1_cc = len(l1_constraints['check_constraints'])
            if l0_cc == l1_cc:
                validation_results['check_constraints']['status'] = 'MATCH'
                validation_results['check_constraints']['details'] = f"Check constraint count matches: {l0_cc}"
            else:
                validation_results['check_constraints']['status'] = 'MISMATCH'
                validation_results['check_constraints']['details'] = (
                    f"Check constraint mismatch: L0={l0_cc}, L1={l1_cc}"
                )
                if l0_cc > l1_cc:
                    constraint_counts['check_constraints']['l0'] = l0_cc - l1_cc
                else:
                    constraint_counts['check_constraints']['l1'] = l1_cc - l0_cc

            # ==================== FOREIGN KEYS ====================
            l0_fk = len(l0_constraints['foreign_keys'])
            l1_fk = len(l1_constraints['foreign_keys'])
            if l0_fk == l1_fk == 0:
                validation_results['foreign_keys']['status'] = 'NONE'
                validation_results['foreign_keys']['details'] = "No foreign keys in either layer"
            elif l0_fk == l1_fk:
                validation_results['foreign_keys']['status'] = 'MATCH'
                validation_results['foreign_keys']['details'] = f"Foreign key count matches: {l0_fk}"
            else:
                validation_results['foreign_keys']['status'] = 'MISMATCH'
                validation_results['foreign_keys']['details'] = f"Foreign key mismatch: L0={l0_fk}, L1={l1_fk}"
                if l0_fk > l1_fk:
                    constraint_counts['foreign_keys']['l0'] = l0_fk - l1_fk
                else:
                    constraint_counts['foreign_keys']['l1'] = l1_fk - l0_fk

        except Exception as e:
            log_detailed_error(
                "Constraint Analysis Failed", e,
                {"L0 Table": l0_table, "L1 Table": l1_table}
            )
            return {
                'constraint_analysis_performed': True,
                'constraint_warnings': {'error': f"Error during constraint analysis: {str(e)}"},
                'validation_results': validation_results,
                'summary': {k: v['status'] for k, v in validation_results.items()}
            }

        # Build constraint warnings summary
        constraint_warnings = {}
        for ctype, counts in constraint_counts.items():
            if counts['l0'] > 0 or counts['l1'] > 0:
                type_name = ctype.replace('_', ' ').title()
                constraint_warnings[f"{type_name} mismatch"] = f"L0={counts['l0']}, L1={counts['l1']}"

        return {
            'constraint_analysis_performed': True,
            'constraint_warnings': constraint_warnings,
            'validation_results': validation_results,
            'summary': {k: v['status'] for k, v in validation_results.items()}
        }

    def _perform_validation(self, l0_conn, l1_conn, l0_table: str, l1_table: str) -> Dict:
        """Perform the full L0 vs L1 validation for a single table pair"""
        l0_columns = l0_conn.get_columns(l0_table)
        l1_columns = l1_conn.get_columns(l1_table)

        l0_columns = self._filter_excluded_columns(l0_columns)
        l1_columns = self._filter_excluded_columns(l1_columns)

        if not l0_columns or not l1_columns:
            raise Exception('Unable to retrieve columns from L0 or L1')

        # Column structure comparison
        l0_col_names = {col['name'].upper() for col in l0_columns}
        l1_col_names = {col['name'].upper() for col in l1_columns}
        common_columns = l0_col_names & l1_col_names
        l0_only = l0_col_names - l1_col_names
        l1_only = l1_col_names - l0_col_names

        l0_common_cols = [col for col in l0_columns if col['name'].upper() in common_columns]
        l1_common_cols = [col for col in l1_columns if col['name'].upper() in common_columns]

        # Run all checks
        l0_count, l1_count = self._get_row_counts_parallel(l0_conn, l1_conn, l0_table, l1_table)

        column_statistics = self._analyze_column_statistics(
            l0_conn, l1_conn, l0_columns, l1_columns, l0_table, l1_table
        )

        l0_nulls, l1_nulls = self._get_overall_null_count_parallel(
            l0_conn, l1_conn, l0_table, l1_table, l0_common_cols, l1_common_cols
        )

        l0_dupes, l1_dupes = self._get_duplicate_count_parallel(
            l0_conn, l1_conn, l0_table, l1_table, l0_common_cols, l1_common_cols
        )

        constraint_analysis = self._analyze_constraints(l0_conn, l1_conn, l0_table, l1_table)

        # Determine overall validation status
        validation_issues = []
        if l0_count != l1_count:
            validation_issues.append(f"Row count mismatch: L0={l0_count}, L1={l1_count}")
        if l0_only:
            validation_issues.append(f"Columns only in L0: {', '.join(sorted(l0_only))}")
        if l1_only:
            validation_issues.append(f"Columns only in L1: {', '.join(sorted(l1_only))}")
        if l0_nulls != l1_nulls:
            validation_issues.append(f"Null count mismatch: L0={l0_nulls}, L1={l1_nulls}")
        if l0_dupes != l1_dupes:
            validation_issues.append(f"Duplicate count mismatch: L0={l0_dupes}, L1={l1_dupes}")
        for col_stat in column_statistics:
            if not col_stat['stats_match']['distinct_count']:
                validation_issues.append(
                    f"Column {col_stat['column_name']}: distinct count mismatch "
                    f"(L0={col_stat['l0_stats']['distinct_count']}, L1={col_stat['l1_stats']['distinct_count']})"
                )

        status = 'PASSED' if not validation_issues else 'CRITICAL'

        return {
            'l0_table': l0_table,
            'l1_table': l1_table,
            'status': status,
            'row_counts': {
                'l0': l0_count,
                'l1': l1_count,
                'match': l0_count == l1_count
            },
            'column_analysis': {
                'l0_columns': len(l0_columns),
                'l1_columns': len(l1_columns),
                'common_columns': len(common_columns),
                'l0_only_columns': list(sorted(l0_only)),
                'l1_only_columns': list(sorted(l1_only))
            },
            'data_quality': {
                'l0_nulls': l0_nulls,
                'l1_nulls': l1_nulls,
                'null_match': l0_nulls == l1_nulls,
                'l0_duplicates': l0_dupes,
                'l1_duplicates': l1_dupes,
                'duplicate_match': l0_dupes == l1_dupes
            },
            'column_statistics': column_statistics,
            'constraint_analysis': constraint_analysis,
            'validation_issues': validation_issues
        }

    def _validate_single_table(self, l0_table: str) -> Dict:
        """Validate a single L0→L1 table pair"""
        start_time = time.time()
        l1_table = f"{l0_table}{self.l1_table_suffix}"

        l0_conn = self.l0_pool.get_connection()
        if not l0_conn:
            return {
                'l0_table': l0_table, 'l1_table': l1_table,
                'status': 'ERROR', 'error': 'Failed to get L0 connection from pool',
                'validation_time': time.time() - start_time,
                'Last_Checked': datetime.now().isoformat()
            }

        l1_conn = self.l1_pool.get_connection()
        if not l1_conn:
            self.l0_pool.return_connection(l0_conn)
            return {
                'l0_table': l0_table, 'l1_table': l1_table,
                'status': 'ERROR', 'error': 'Failed to get L1 connection from pool',
                'validation_time': time.time() - start_time,
                'Last_Checked': datetime.now().isoformat()
            }

        # Show exactly what is being looked up so mismatches are obvious
        print_safe(
            f"       🔍 Looking up L1 table: "
            f"[{l1_conn.database}].[{l1_conn.schema}].[{l1_table}]"
        )

        # Check if the L1 table exists
        if not l1_conn.table_exists(l1_table):
            print_safe(
                f"       ✗ TABLE NOT FOUND — "
                f"DB: {l1_conn.database} | Schema: {l1_conn.schema} | Table: {l1_table}"
            )
            self.l0_pool.return_connection(l0_conn)
            self.l1_pool.return_connection(l1_conn)
            return {
                'l0_table': l0_table, 'l1_table': l1_table,
                'status': 'TABLE_NOT_FOUND',
                'error': (
                    f"L1 table not found — "
                    f"DB: {l1_conn.database}, Schema: {l1_conn.schema}, Table: {l1_table}"
                ),
                'validation_time': time.time() - start_time,
                'L1_Last_Updated': None,
                'Last_Checked': datetime.now().isoformat()
            }

        print_safe(f"       ✓ L1 table '{l1_table}' found")
        l1_last_updated = l1_conn.get_table_last_altered(l1_table)

        try:
            result = self._perform_validation(l0_conn, l1_conn, l0_table, l1_table)
            self.l0_pool.return_connection(l0_conn)
            self.l1_pool.return_connection(l1_conn)
            result['validation_time'] = time.time() - start_time
            result['L1_Last_Updated'] = l1_last_updated
            result['Last_Checked'] = datetime.now().isoformat()
            return result
        except Exception as e:
            log_detailed_error(
                f"Table Validation Failed - {l0_table}", e,
                {"L0 Table": l0_table, "L1 Table": l1_table}
            )
            self.l0_pool.return_connection(l0_conn)
            self.l1_pool.return_connection(l1_conn)
            return {
                'l0_table': l0_table, 'l1_table': l1_table,
                'status': 'ERROR', 'error': str(e),
                'validation_time': time.time() - start_time,
                'L1_Last_Updated': l1_last_updated,
                'Last_Checked': datetime.now().isoformat()
            }

    def _validate_single_table_with_timeout(self, table: str, timeout: int) -> Dict:
        """Validate a table with timeout support - abandons thread on timeout"""
        l1_table = f"{table}{self.l1_table_suffix}"
        executor = ThreadPoolExecutor(max_workers=1)
        future = executor.submit(self._validate_single_table, table)

        try:
            result = future.result(timeout=timeout)
            executor.shutdown(wait=True)
            return result
        except TimeoutError:
            print_safe(f"       ⚠️  Timeout detected, abandoning validation thread for {table}...")
            self.has_abandoned_threads = True
            executor.shutdown(wait=False)
            error_msg = f'Validation exceeded {timeout}s timeout'
            log_detailed_error(
                f"Table Validation Timeout - {table}",
                Exception(error_msg),
                {"L0 Table": table, "L1 Table": l1_table, "Timeout": f"{timeout}s"}
            )
            return {
                'l0_table': table, 'l1_table': l1_table,
                'status': 'TIMEOUT', 'error': error_msg,
                'validation_time': timeout,
                'Last_Checked': datetime.now().isoformat()
            }
        except Exception as e:
            executor.shutdown(wait=True)
            raise

    def run_validation(self):
        """Run validation for all L0 tables"""
        print_safe(f"\n📋 Validating {len(self.tables)} table(s)...")
        start_time = time.time()

        if self.parallel_execution:
            with ThreadPoolExecutor(max_workers=self.max_parallel_tables) as executor:
                future_to_table = {
                    executor.submit(self._validate_single_table_with_timeout, table, self.table_timeout): table
                    for table in self.tables
                }
                for future in as_completed(future_to_table):
                    table = future_to_table[future]
                    try:
                        result = future.result()
                    except Exception as e:
                        result = {
                            'l0_table': table,
                            'l1_table': f"{table}{self.l1_table_suffix}",
                            'status': 'ERROR', 'error': str(e),
                            'validation_time': 0,
                            'Last_Checked': datetime.now().isoformat()
                        }
                        print_safe(f"   ❌ {table}: Exception - {e}")

                    status_icon = "✅" if result['status'] == 'PASSED' else (
                        "⊘" if result['status'] == 'TABLE_NOT_FOUND' else "❌"
                    )
                    print_safe(f"   {status_icon} {table} → {result['l1_table']} [{result['status']}]")

                    with self.results_lock:
                        self.results['table_validations'].append(result)
        else:
            for table in self.tables:
                result = self._validate_single_table_with_timeout(table, self.table_timeout)
                status_icon = "✅" if result['status'] == 'PASSED' else (
                    "⊘" if result['status'] == 'TABLE_NOT_FOUND' else "❌"
                )
                print_safe(f"   {status_icon} {table} → {result['l1_table']} [{result['status']}]")
                self.results['table_validations'].append(result)

        # Retry timed-out tables
        timeout_tables = [r['l0_table'] for r in self.results['table_validations'] if r['status'] == 'TIMEOUT']
        for table in timeout_tables:
            for attempt in range(self.max_retries):
                print_safe(f"   🔄 Retry {attempt + 1}/{self.max_retries} for timed-out table: {table}")
                retry_result = self._validate_single_table_with_timeout(table, self.table_timeout)

                with self.results_lock:
                    self.results['table_validations'] = [
                        r for r in self.results['table_validations'] if r.get('l0_table') != table
                    ]
                    self.results['table_validations'].append(retry_result)

                if retry_result['status'] != 'TIMEOUT':
                    break

                if attempt == self.max_retries - 1:
                    self.results['faulty_tables'].append({
                        'table_name': table,
                        'l1_table': f"{table}{self.l1_table_suffix}",
                        'reason': f'Validation exceeded {self.table_timeout}s timeout',
                        'retry_attempts': self.max_retries
                    })

        # Compute summary
        total_time = time.time() - start_time
        passed = sum(1 for r in self.results['table_validations'] if r['status'] == 'PASSED')
        critical = sum(1 for r in self.results['table_validations'] if r['status'] == 'CRITICAL')
        errors = sum(1 for r in self.results['table_validations'] if r['status'] == 'ERROR')
        faulty = len(self.results['faulty_tables'])
        not_found = sum(1 for r in self.results['table_validations'] if r['status'] == 'TABLE_NOT_FOUND')

        self.results['summary'] = {
            'total_validations': len(self.results['table_validations']),
            'passed': passed,
            'critical': critical,
            'errors': errors,
            'faulty': faulty,
            'not_found': not_found,
            'total_execution_time': round(total_time, 2),
            'success_rate': round(
                (passed / len(self.results['table_validations']) * 100), 2
            ) if self.results['table_validations'] else 0
        }

        summary_parts = [f"✅ {passed}", f"🚨 {critical}", f"⚠️ {errors}"]
        if not_found > 0:
            summary_parts.append(f"⊘ {not_found} not found")
        if faulty > 0:
            summary_parts.append(f"🔴 {faulty} faulty")
        print_safe(
            f"    ⏱️  Completed in {self.results['summary']['total_execution_time']}s | "
            + " | ".join(summary_parts)
        )

    def get_results(self) -> Dict:
        return self.results


# ─── Config / utility helpers ────────────────────────────────────────────────

def load_config_file(config_path: str) -> Dict:
    try:
        with open(config_path, 'r') as f:
            return json.load(f)
    except FileNotFoundError:
        print_safe(f"❌ Config file not found: {config_path}")
        sys.exit(1)
    except json.JSONDecodeError as e:
        print_safe(f"❌ Invalid JSON in config file: {e}")
        sys.exit(1)


def get_optional_config_value(config: Dict, section: str, key: str, default=None):
    try:
        return config[section].get(key, default)
    except KeyError:
        return default


# ─── Main ─────────────────────────────────────────────────────────────────────


# ─── Per-schema validation orchestrator ──────────────────────────────────────

def validate_single_schema(l0_schema: str, l1_schema: str,
                            l0_config: dict, l1_config: dict,
                            validation_config: dict,
                            schema_index: int, total_schemas: int) -> Dict:
    """Validate one L0↔L1 schema pair. Called in parallel from main()."""
    start_time = time.time()
    print_header(
        f"Schema {schema_index}/{total_schemas}: {l0_schema} → {l1_schema}", "-", 80
    )

    excluded_columns    = validation_config.get('excluded_columns', [])
    parallel_execution  = validation_config.get('parallel_execution', True)
    max_parallel_tables = validation_config.get('max_parallel_tables', 5)
    table_timeout       = validation_config.get('table_timeout', 60)
    max_retries         = validation_config.get('max_retries', 3)

    # Suffix is auto-derived from the L0 schema name: e.g. schema 'insight7' → '__insight7'
    # An optional suffix_separator in config allows customising the separator (default '__')
    suffix_separator = validation_config.get('suffix_separator', '__')
    l1_table_suffix  = f"{suffix_separator}{l0_schema.upper()}"

    # Build per-schema connector params
    l0_params = {k: v for k, v in l0_config.items() if k not in ('schema_prefix',)}
    l0_params['schema'] = l0_schema

    l1_params = {k: v for k, v in l1_config.items() if k not in ('schema_prefix', 'table_suffix')}
    l1_params['schema'] = l1_schema

    # Create connection pools for this schema pair
    l0_pool = ConnectionPool(SnowflakeConnector, l0_params, max_connections=max_parallel_tables)
    l1_pool = ConnectionPool(SnowflakeConnector, l1_params, max_connections=max_parallel_tables)

    # Discover tables in this L0 schema
    try:
        discovery = SnowflakeConnector(**l0_params)
        if not discovery.connect():
            raise Exception(f"Could not connect to L0 schema {l0_schema}")
        tables = discovery.get_all_tables()
        discovery.disconnect()
    except Exception as e:
        l0_pool.close_all()
        l1_pool.close_all()
        return {
            'l0_schema': l0_schema,
            'l1_schema': l1_schema,
            'status': 'ERROR',
            'error': f"Table discovery failed: {str(e)}",
            'execution_time': round(time.time() - start_time, 2),
            'summary': {},
            'table_validations': [],
            'faulty_tables': []
        }

    if not tables:
        print_safe(f"⚠️  No tables found in L0 schema {l0_schema}, skipping.")
        l0_pool.close_all()
        l1_pool.close_all()
        return {
            'l0_schema': l0_schema,
            'l1_schema': l1_schema,
            'status': 'SKIPPED',
            'error': 'No tables found in L0 schema',
            'execution_time': round(time.time() - start_time, 2),
            'summary': {},
            'table_validations': [],
            'faulty_tables': []
        }

    print_safe(f"   📋 {len(tables)} table(s) found in {l0_schema}")
    print_safe(f"   🔗 L1 table suffix (auto-derived): '{l1_table_suffix}'  "
               f"(e.g. L0 table 'ORDERS' → L1 table 'ORDERS{l1_table_suffix}')")

    # ── Verify the L1 schema actually exists before attempting any validation ──
    print_safe(f"   🔍 Verifying L1 schema exists: [{l1_config['database']}].[{l1_schema}]")
    try:
        l1_check_params = {k: v for k, v in l1_config.items() if k not in ('schema_prefix',)}
        l1_check_params['schema'] = l1_schema
        l1_check_conn = SnowflakeConnector(**l1_check_params)
        if not l1_check_conn.connect():
            raise Exception("Connection returned False")

        cursor = l1_check_conn.conn.cursor()
        cursor.execute(f"""
            SELECT COUNT(*)
            FROM "{l1_config['database']}".INFORMATION_SCHEMA.SCHEMATA
            WHERE UPPER(SCHEMA_NAME) = %s
        """, (l1_schema.upper(),))
        schema_count = cursor.fetchone()[0]
        cursor.close()
        l1_check_conn.disconnect()

        if schema_count == 0:
            print_safe(
                f"   ❌ L1 schema '{l1_schema}' does NOT exist in {l1_config['database']}. "
                f"Check your schema_prefix config. Skipping this schema pair."
            )
            l0_pool.close_all()
            l1_pool.close_all()
            return {
                'l0_schema': l0_schema, 'l1_schema': l1_schema,
                'status': 'SCHEMA_NOT_FOUND',
                'error': f"L1 schema '{l1_schema}' not found in {l1_config['database']}",
                'execution_time': round(time.time() - start_time, 2),
                'summary': {}, 'table_validations': [], 'faulty_tables': []
            }
        print_safe(f"   ✅ L1 schema '{l1_schema}' confirmed")
    except Exception as e:
        print_safe(f"   ⚠️  Could not verify L1 schema (will attempt anyway): {e}")

    validator = DataValidator(
        l0_pool=l0_pool,
        l1_pool=l1_pool,
        tables=tables,
        l1_table_suffix=l1_table_suffix,
        excluded_columns=excluded_columns,
        parallel_execution=parallel_execution,
        max_parallel_tables=max_parallel_tables,
        table_timeout=table_timeout,
        max_retries=max_retries
    )

    validator.run_validation()
    results = validator.get_results()

    force_skip = validator.has_abandoned_threads
    l0_pool.close_all(force_skip_disconnect=force_skip)
    l1_pool.close_all(force_skip_disconnect=force_skip)

    summary = results['summary']
    return {
        'l0_schema':        l0_schema,
        'l1_schema':        l1_schema,
        'status':           'SUCCESS',
        'execution_time':   round(time.time() - start_time, 2),
        'summary':          summary,
        'table_validations': results['table_validations'],
        'faulty_tables':    results.get('faulty_tables', [])
    }


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description='L0 to L1 Snowflake Data Validation (Multi-Schema)')
    parser.add_argument('--config', '-c', help='Config JSON file', default="validation_config.json")
    args = parser.parse_args()

    print_header("L0 → L1 Snowflake Data Validation (Multi-Schema)", "=", 80)

    config = load_config_file(args.config)

    # ── Load layer configs ────────────────────────────────────────────────────
    try:
        l0_config = load_snowflake_layer_config(config, 'l0')
        print_safe(
            f"✅ L0 config loaded: {l0_config['account']} / {l0_config['database']} "
            f"(auth: {l0_config['auth_type']})"
        )
    except Exception as e:
        print_safe(f"❌ L0 configuration error: {e}")
        sys.exit(1)

    try:
        l1_config = load_snowflake_layer_config(config, 'l1')
        schema_prefix = l1_config.get('schema_prefix', '')
        print_safe(
            f"✅ L1 config loaded: {l1_config['account']} / {l1_config['database']} "
            f"(auth: {l1_config['auth_type']})"
        )
        if schema_prefix:
            print_safe(f"   🔗 L1 schema prefix : '{schema_prefix}'  "
                       f"(e.g. L0 'insight7' → L1 '{schema_prefix}insight7')")
        else:
            print_safe("   ℹ️  No L1 schema prefix — using same schema names as L0")
        suffix_separator = config.get('validation', {}).get('suffix_separator', '__')
        print_safe(f"   🔗 L1 table suffix  : auto-derived per schema  "
                   f"(e.g. schema 'insight7' → suffix '{suffix_separator}insight7')")
    except Exception as e:
        print_safe(f"❌ L1 configuration error: {e}")
        sys.exit(1)

    try:
        sf_save_config = load_snowflake_save_config(config)
        print_safe(
            f"✅ Snowflake save config loaded: "
            f"{sf_save_config['account']} / {sf_save_config['database']}"
        )
    except Exception as e:
        print_safe(f"❌ Snowflake Save configuration error: {e}")
        sys.exit(1)

    # ── Validation settings ───────────────────────────────────────────────────
    validation_config = config.get('validation', {})
    max_parallel_schemas = validation_config.get('max_parallel_schemas', 3)

    # ── Discover L0 schemas ───────────────────────────────────────────────────
    print_safe(f"\n🔍 Discovering schemas in L0 database ({l0_config['database']})...")

    # Optional explicit schema list; otherwise auto-discover
    explicit_schemas = validation_config.get('schemas', [])

    if explicit_schemas:
        l0_schemas = [s.upper() for s in explicit_schemas]
        print_safe(f"✅ Using {len(l0_schemas)} explicit schema(s) from config")
    else:
        try:
            disc_params = {k: v for k, v in l0_config.items()}
            disc_conn = SnowflakeConnector(**disc_params)
            if not disc_conn.connect():
                print_safe("❌ Failed to connect to L0 for schema discovery")
                sys.exit(1)
            l0_schemas = disc_conn.get_all_schemas()
            disc_conn.disconnect()
            print_safe(f"✅ Auto-discovered {len(l0_schemas)} schema(s) in L0")
        except Exception as e:
            print_safe(f"❌ Failed to discover L0 schemas: {e}")
            sys.exit(1)

    if not l0_schemas:
        print_safe("❌ No schemas found in L0 to validate")
        sys.exit(1)

    # ── Build schema pairs ────────────────────────────────────────────────────
    schema_pairs = []
    for l0_schema in l0_schemas:
        l1_schema = f"{schema_prefix}{l0_schema}"
        schema_pairs.append((l0_schema, l1_schema))

    print_safe(f"\n📋 Schema pairs to validate ({len(schema_pairs)} total):")
    for l0_s, l1_s in schema_pairs:
        print_safe(f"   {l0_s:<35} → {l1_s}")

    # ── Run parallel schema validation ────────────────────────────────────────
    overall_start = time.time()
    print_safe(
        f"\n🚀 Starting validation with up to {max_parallel_schemas} parallel schema worker(s)..."
    )

    all_schema_results = []

    with ThreadPoolExecutor(max_workers=max_parallel_schemas) as executor:
        future_to_pair = {
            executor.submit(
                validate_single_schema,
                l0_s, l1_s, l0_config, l1_config, validation_config,
                idx + 1, len(schema_pairs)
            ): (l0_s, l1_s)
            for idx, (l0_s, l1_s) in enumerate(schema_pairs)
        }

        for future in as_completed(future_to_pair):
            l0_s, l1_s = future_to_pair[future]
            try:
                result = future.result()
            except Exception as e:
                result = {
                    'l0_schema': l0_s, 'l1_schema': l1_s,
                    'status': 'ERROR',
                    'error': str(e),
                    'execution_time': 0,
                    'summary': {}, 'table_validations': [], 'faulty_tables': []
                }
            icon = "✅" if result['status'] == 'SUCCESS' else (
                   "⚠️ " if result['status'] == 'SKIPPED' else "❌")
            print_safe(f"\n{icon} Finished schema: {l0_s} → {l1_s} [{result['status']}]")
            all_schema_results.append(result)

    overall_time = round(time.time() - overall_start, 2)

    # Sort by schema name for consistent output
    all_schema_results.sort(key=lambda x: x['l0_schema'])

    # ── Build consolidated report ─────────────────────────────────────────────
    total_tables   = sum(len(r['table_validations']) for r in all_schema_results)
    total_passed   = sum(r['summary'].get('passed', 0)   for r in all_schema_results)
    total_critical = sum(r['summary'].get('critical', 0) for r in all_schema_results)
    total_errors   = sum(r['summary'].get('errors', 0)   for r in all_schema_results)
    total_not_found = sum(r['summary'].get('not_found', 0) for r in all_schema_results)
    total_faulty   = sum(r['summary'].get('faulty', 0)   for r in all_schema_results)

    consolidated_report = {
        'report_metadata': {
            'generated_timestamp':  datetime.now().isoformat(),
            'total_schemas':        len(schema_pairs),
            'total_tables':         total_tables,
            'total_execution_time': overall_time,
            'l0_database':          l0_config['database'],
            'l1_database':          l1_config['database'],
            'l1_schema_prefix':    schema_prefix,
            'l1_table_suffix_rule': f"{config.get('validation', {}).get('suffix_separator', '__')}<l0_schema_name>  (auto-derived per schema)",
        },
        'overall_summary': {
            'total_validations': total_tables,
            'passed':            total_passed,
            'critical':          total_critical,
            'errors':            total_errors,
            'not_found':         total_not_found,
            'faulty':            total_faulty,
            'failed_runs':       total_critical + total_errors,
            'success_rate':      round(total_passed / total_tables * 100, 2) if total_tables else 0
        },
        'schema_results': all_schema_results
    }

    # ── Save to Snowflake ─────────────────────────────────────────────────────
    print_safe("\n💾 Saving consolidated report to Snowflake...")
    try:
        save_report_to_snowflake(consolidated_report, sf_save_config)
    except Exception as e:
        print_safe(f"\n❌ Failed to save report to Snowflake: {e}")
        print_safe("❌ Validation aborted due to database save failure")
        sys.exit(1)

    # ── Print overall summary ─────────────────────────────────────────────────
    print_header("OVERALL VALIDATION SUMMARY", "=", 80)
    ov = consolidated_report['overall_summary']
    print_safe(f"\n📊 ACROSS ALL SCHEMAS:")
    print_safe(f"   Total Tables Validated : {ov['total_validations']}")
    print_safe(f"   ✅ Passed              : {ov['passed']}")
    print_safe(f"   🚨 Critical            : {ov['critical']}")
    print_safe(f"   ⚠️  Errors             : {ov['errors']}")
    if ov['not_found'] > 0:
        print_safe(f"   ⊘  Not Found in L1   : {ov['not_found']}")
    if ov['faulty'] > 0:
        print_safe(f"   🔴 Faulty (Timeout)  : {ov['faulty']}")
    print_safe(f"   📈 Success Rate        : {ov['success_rate']}%")
    print_safe(f"\n⏱️  TOTAL EXECUTION TIME : {overall_time}s")

    # ── Per-schema summary table ──────────────────────────────────────────────
    print_header("PER-SCHEMA SUMMARY", "-", 80)
    print_safe(f"\n{'L0 Schema':<30} {'L1 Schema':<30} {'Tables':>7} {'✅':>6} {'🚨':>6} {'⚠️':>6} {'Time':>8}")
    print_safe("-" * 95)

    for r in all_schema_results:
        s = r['summary']
        l0_disp = (r['l0_schema'][:28] + '..') if len(r['l0_schema']) > 30 else r['l0_schema']
        l1_disp = (r['l1_schema'][:28] + '..') if len(r['l1_schema']) > 30 else r['l1_schema']
        tables   = str(s.get('total_validations', 'N/A'))
        passed   = str(s.get('passed', 'N/A'))
        critical = str(s.get('critical', 'N/A'))
        errors   = str(s.get('errors', 'N/A'))
        t_time   = f"{r['execution_time']}s"
        status_icon = "✅" if r['status'] == 'SUCCESS' else ("⚠️ " if r['status'] == 'SKIPPED' else "❌")
        print_safe(
            f"{status_icon} {l0_disp:<28} {l1_disp:<30} {tables:>7} {passed:>6} {critical:>6} {errors:>6} {t_time:>8}"
        )

    # ── Per-schema detailed table breakdown ───────────────────────────────────
    for r in all_schema_results:
        if not r['table_validations']:
            continue
        print_header(f"TABLES: {r['l0_schema']} → {r['l1_schema']}", "-", 80)
        print_safe(f"\n  {'L0 Table':<35} {'L1 Table':<35} Status")
        print_safe("  " + "-" * 78)
        for tv in r['table_validations']:
            l0t = tv.get('l0_table', 'N/A')
            l1t = tv.get('l1_table', 'N/A')
            st  = tv.get('status', 'N/A')
            icon = "✅" if st == 'PASSED' else ("⊘" if st == 'TABLE_NOT_FOUND' else "❌")
            l0td = (l0t[:33] + '..') if len(l0t) > 35 else l0t
            l1td = (l1t[:33] + '..') if len(l1t) > 35 else l1t
            print_safe(f"  {l0td:<35} {l1td:<35} {icon} {st}")

    # ── Faulty tables ─────────────────────────────────────────────────────────
    all_faulty = [
        (r['l0_schema'], f) for r in all_schema_results for f in r.get('faulty_tables', [])
    ]
    if all_faulty:
        print_header("FAULTY TABLES (TIMEOUT)", "-", 80)
        for schema, f in all_faulty:
            print_safe(
                f"   🔴 [{schema}] {f['table_name']} → {f.get('l1_table', 'N/A')} - {f['reason']}"
            )
        print_safe("")

    print_safe("=" * 80)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print_safe("\n⚠️  Interrupted by user")
        sys.exit(0)
    except Exception as e:
        print_safe(f"\n❌ Error: {e}")
        tb.print_exc()
        sys.exit(1)