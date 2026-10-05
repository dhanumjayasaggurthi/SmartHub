import requests
import json
import sys
import os
import re
import urllib3
import paramiko
import configparser
from urllib.parse import quote
from datetime import datetime, timedelta
from typing import Dict, List, Set, Tuple, Optional
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed
from threading import Lock

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)


class Config:
    BASE_URL = None
    USERNAME = None
    PASSWORD = None
    OUTPUT_DIR = None
    REQUEST_TIMEOUT = None
    THREAD_POOL_SIZE = None

    @classmethod
    def load(cls):
        """Load configuration from INI file into class attributes."""
        # The SmartHub backend runs this script and hands the credentials over in the environment,
        # so the server doesn't need a second copy of them in config.ini.
        if os.environ.get('STREAMSETS_URL'):
            try:
                cls.BASE_URL = os.environ['STREAMSETS_URL']
                cls.USERNAME = os.environ['STREAMSETS_USERNAME']
                cls.PASSWORD = os.environ['STREAMSETS_PASSWORD']
                cls.OUTPUT_DIR = os.environ.get('STREAMSETS_OUTPUT_DIR', 'output')
                cls.REQUEST_TIMEOUT = int(os.environ.get('STREAMSETS_REQUEST_TIMEOUT', 30))
                cls.THREAD_POOL_SIZE = int(os.environ.get('STREAMSETS_THREAD_POOL_SIZE', 5))
            except (KeyError, ValueError) as e:
                print(f"\n❌ ERROR: Bad STREAMSETS_* environment settings: {e}")
                sys.exit(1)
            print("✅ Configuration loaded from environment")
            return

        # cwd first (old behaviour), then next to the script so it works from any folder / scheduler
        config_file = 'config.ini'
        if not os.path.exists(config_file):
            config_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'config.ini')

        if not os.path.exists(config_file):
            print(f"\n❌ ERROR: Configuration file '{config_file}' not found!")
            print(f"   Please create '{config_file}' in the same directory as this script.")
            print(f"   See the documentation for the required configuration format.")
            sys.exit(1)

        parser = configparser.ConfigParser()

        try:
            parser.read(config_file)

            # Load StreamSets settings into class attributes
            cls.BASE_URL = parser.get('streamsets', 'url')
            cls.USERNAME = parser.get('streamsets', 'username')
            cls.PASSWORD = parser.get('streamsets', 'password')

            # Load General settings into class attributes
            cls.OUTPUT_DIR = parser.get('general', 'output_dir', fallback='output')
            cls.REQUEST_TIMEOUT = parser.getint('general', 'request_timeout', fallback=30)
            cls.THREAD_POOL_SIZE = parser.getint('general', 'thread_pool_size', fallback=5)

            print(f"✅ Configuration loaded from '{config_file}'")

        except configparser.Error as e:
            print(f"\n❌ ERROR: Failed to parse configuration file '{config_file}'")
            print(f"   {str(e)}")
            sys.exit(1)
        except Exception as e:
            print(f"\n❌ ERROR: Failed to load configuration: {str(e)}")
            sys.exit(1)


# Load configuration on module import
Config.load()


class StreamSetsAPIClient:

    def __init__(self, base_url: str, username: str, password: str):
        self.base_url = base_url.rstrip('/')
        self.session = requests.Session()
        self.auth_token = None
        self._creds = (username, password)
        self._auth_lock = Lock()
        self._commit_cache = {}
        self._authenticate(username, password)

    def _authenticate(self, username: str, password: str):
        auth_url = f"{self.base_url}/security/public-rest/v1/authentication/login"

        try:
            print("🔐 Authenticating...")
            response = requests.post(
                auth_url,
                json={"userName": username, "password": password},
                headers={"Content-Type": "application/json", "X-Requested-By": "SCH"},
                verify=False,
                timeout=30
            )

            if response.status_code == 200:
                self.auth_token = response.headers.get('X-SS-User-Auth-Token')
                if self.auth_token:
                    self.session.headers.update({
                        "X-SS-User-Auth-Token": self.auth_token,
                        "X-Requested-By": "SCH",
                        "Content-Type": "application/json"
                    })
                    print("✅ Authentication successful!")
                    return

            print(f"❌ Authentication failed: Status {response.status_code}")
            sys.exit(1)

        except Exception as e:
            print(f"❌ Authentication error: {e}")
            sys.exit(1)

    def request(self, method: str, endpoint: str, **kwargs):
        # A commit never changes, and the same fragment commits get asked for by every stage and
        # pipeline that uses them - fetch each one once per run.
        if method == 'GET' and endpoint.startswith('pipelinestore/rest/v1/pipelineCommit/') and not kwargs:
            with self._auth_lock:
                cached = self._commit_cache.get(endpoint)
            if cached is not None:
                return cached
            result = self._request(method, endpoint)
            if result:
                with self._auth_lock:
                    self._commit_cache[endpoint] = result
            return result
        return self._request(method, endpoint, **kwargs)

    def _request(self, method: str, endpoint: str, **kwargs):
        parts = endpoint.split('/')
        encoded_parts = [quote(part, safe='') if part else part for part in parts]
        url = f"{self.base_url}/{'/'.join(encoded_parts)}"

        kwargs.setdefault('verify', False)
        kwargs.setdefault('timeout', Config.REQUEST_TIMEOUT)

        try:
            response = self.session.request(method, url, **kwargs)

            # token expires on long runs -> log in again once and retry
            if response.status_code == 401:
                with self._auth_lock:
                    self._authenticate(*self._creds)
                response = self.session.request(method, url, **kwargs)

            if response.status_code == 200:
                if not response.text.strip():
                    return []

                try:
                    data = response.json()
                    if isinstance(data, dict) and 'data' in data:
                        return data['data']
                    return data
                except json.JSONDecodeError:
                    print(f"⚠️  Invalid JSON response from {endpoint}")
                    return []
            else:
                print(f"⚠️  Request failed: {response.status_code} - {endpoint}")
                return []

        except requests.exceptions.Timeout:
            print(f"❌ Request timeout: {endpoint}")
            return []
        except Exception as e:
            print(f"❌ Request error: {e}")
            return []

    def get_all_sdcs(self) -> List[Dict]:
        """Fetch all registered SDC instances."""
        print("🔍 Fetching all registered SDCs...")
        sdcs = self.request('GET', 'jobrunner/rest/v1/sdcs')
        if sdcs:
            print(f"   ✅ Found {len(sdcs)} SDC(s)")
        else:
            print("   ⚠️  No SDCs found or failed to fetch")
        return sdcs if sdcs else []


class SDCClient:

    def __init__(self, sdc_url: str, username: str, password: str, sdc_id: str = None):
        self.sdc_url = sdc_url.rstrip('/')
        self.sdc_id = sdc_id or sdc_url
        self.host = self._extract_hostname(sdc_url)
        self.port = 22
        self.username = username
        self.password = password
        self.connected = False
        self.ssh_client = None
        self.sftp_client = None
        self.lock = Lock()  # Thread safety for the connection

    def _extract_hostname(self, sdc_url: str) -> str:
        url = sdc_url.replace('https://', '').replace('http://', '')
        hostname = url.split(':')[0].split('/')[0]
        return hostname

    def connect(self) -> bool:
        """Establish persistent SSH and SFTP connection."""
        with self.lock:
            if self.connected:
                return True

            try:
                self.ssh_client = paramiko.SSHClient()
                self.ssh_client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
                self.ssh_client.connect(
                    self.host,
                    self.port,
                    self.username,
                    self.password,
                    timeout=10
                )
                self.sftp_client = self.ssh_client.open_sftp()
                self.connected = True
                print(f"   ✅ Connected to SDC: {self.host}")
                return True
            except Exception as e:
                print(f"   ❌ Failed to connect to SDC {self.host}: {e}")
                self.connected = False
                self.ssh_client = None
                self.sftp_client = None
                return False

    def get_resource(self, resource_path: str) -> Optional[str]:
        """Fetch resource file using the persistent connection."""
        if not self.connected or not self.sftp_client:
            return None

        try:
            full_path = f"/projects/var/lib/sdc-resources/{resource_path}"

            with self.lock:  # Thread-safe file access
                with self.sftp_client.file(full_path, 'r') as remote_file:
                    file_contents = remote_file.read().decode('utf-8').strip()

            return file_contents

        except FileNotFoundError:
            # Don't print here, will be handled by ResourceResolver
            return None
        except Exception as e:
            # Don't print here, will be handled by ResourceResolver
            return None

    def close(self):
        """Close the persistent SSH and SFTP connection."""
        with self.lock:
            try:
                if self.sftp_client:
                    self.sftp_client.close()
                if self.ssh_client:
                    self.ssh_client.close()
                self.connected = False
                print(f"   🔌 Closed connection to SDC: {self.host}")
            except Exception as e:
                print(f"   ⚠️  Error closing connection to {self.host}: {e}")
            finally:
                self.ssh_client = None
                self.sftp_client = None
                self.connected = False


class ResourceResolver:

    def __init__(self, sdc_list: List[Dict], username: str, password: str):
        """
        Initialize ResourceResolver with persistent connections to all SDCs.

        Args:
            sdc_list: List of SDC dictionaries from the API
            username: SSH username for all SDCs
            password: SSH password for all SDCs
        """
        self.sdc_clients: List[SDCClient] = []
        self.username = username
        self.password = password

        if not sdc_list:
            print("⚠️  No SDCs provided for connection pool")
            return

        print(f"\n🔗 Establishing SSH connection pool to {len(sdc_list)} SDC(s)...")

        for sdc_info in sdc_list:
            sdc_url = sdc_info.get('httpUrl')
            sdc_id = sdc_info.get('id', sdc_url)

            if not sdc_url:
                continue

            client = SDCClient(sdc_url, username, password, sdc_id)
            if client.connect():
                self.sdc_clients.append(client)

        if self.sdc_clients:
            print(f"✅ Connection pool established with {len(self.sdc_clients)} SDC(s)")
        else:
            print("❌ Failed to connect to any SDCs")

    def parse_load_resource(self, value: str) -> Optional[str]:
        """Extract resource path from runtime:loadResource() expression."""
        pattern = r'runtime:loadResource\s*\(\s*["\']([^"\']+)["\']\s*,\s*\w+\s*\)'
        match = re.search(pattern, value)

        if match:
            return match.group(1)
        return None

    def resolve_resource(self, value: str) -> Tuple[Optional[str], Optional[str], List[str]]:
        """
        Try to resolve a resource by attempting all SDCs in the connection pool.

        Args:
            value: The parameter value containing runtime:loadResource()

        Returns:
            Tuple of (resolved_content, source_sdc_host, attempted_sdc_hosts)
        """
        resource_path = self.parse_load_resource(value)

        if not resource_path:
            return None, None, []

        if not self.sdc_clients:
            return None, None, []

        attempted_sdcs = []

        for client in self.sdc_clients:
            attempted_sdcs.append(client.host)

            content = client.get_resource(resource_path)
            if content:
                # Successfully resolved
                return content, client.host, attempted_sdcs

        # Failed on all SDCs
        return None, None, attempted_sdcs

    def resolve_all_parameters(self, param_defs: Dict[str, str]) -> Dict[str, Tuple[str, Optional[str], Optional[str]]]:
        """
        Resolve all parameters that contain runtime:loadResource().

        Args:
            param_defs: Dictionary of parameter name -> parameter value

        Returns:
            Dictionary of parameter name -> (original_value, resolved_value, source_sdc)
        """
        resolved = {}

        if not self.sdc_clients:
            print("⚠️  No connected SDCs available for resource resolution")
            return {k: (v, None, None) for k, v in param_defs.items()}

        print(f"\n🔍 Resolving runtime:loadResource() parameters...")
        resolved_count = 0
        failed_count = 0

        for param_name, param_value in param_defs.items():
            if 'runtime:loadResource' in param_value:
                resource_path = self.parse_load_resource(param_value)

                if resource_path:
                    print(f"   📄 Fetching: {resource_path}")

                    resolved_value, source_sdc, attempted_sdcs = self.resolve_resource(param_value)

                    if resolved_value:
                        resolved_count += 1
                        display_value = resolved_value if len(resolved_value) <= 100 else resolved_value[:100] + "..."
                        print(f"      ✅ Resolved from {source_sdc}: {display_value}")
                        resolved[param_name] = (param_value, resolved_value, source_sdc)
                    else:
                        failed_count += 1
                        attempted_hosts = ", ".join(attempted_sdcs)
                        print(f"      ❌ Not found. Tried SDCs: {attempted_hosts}")
                        resolved[param_name] = (param_value, None, None)
                else:
                    # Couldn't parse the resource path
                    resolved[param_name] = (param_value, None, None)
            else:
                # Not a runtime:loadResource parameter
                resolved[param_name] = (param_value, None, None)

        if resolved_count > 0:
            print(f"✅ Successfully resolved {resolved_count} parameter(s)")
        if failed_count > 0:
            print(f"⚠️  Failed to resolve {failed_count} parameter(s)")
        if resolved_count == 0 and failed_count == 0:
            print("ℹ️  No runtime:loadResource parameters found")

        return resolved

    def close_all_connections(self):
        """Close all SDC connections in the pool."""
        if not self.sdc_clients:
            return

        print(f"\n🔌 Closing {len(self.sdc_clients)} SDC connection(s)...")
        for client in self.sdc_clients:
            client.close()
        self.sdc_clients.clear()
        print("✅ All SDC connections closed")


class DataExtractor:

    def __init__(self, api_client: StreamSetsAPIClient):
        self.api = api_client

    def get_all_pipelines(self) -> List[Dict]:
        """Fetch all pipelines from the pipelinestore."""
        print("🔍 Fetching all pipelines from server...")
        endpoint = "pipelinestore/rest/v1/pipelines"
        pipelines = self.api.request('GET', endpoint)

        if pipelines:
            print(f"   ✅ Found {len(pipelines)} total pipelines")
            return pipelines
        else:
            print("   ⚠️  No pipelines found or error fetching pipelines")
            return []

    def get_pipeline_version_info(self, pipeline_id: str) -> Optional[Dict]:
        """Get latest pipeline version/commit information"""
        try:
            print(f"🔍 Fetching latest pipeline version...")
            endpoint = f"pipelinestore/rest/v1/pipeline/{pipeline_id}/latest"
            data = self.api.request("GET", endpoint)

            if data:
                version_info = {
                    'commit_id': data.get('commitId'),
                    'version': data.get('version'),
                    'commit_time': data.get('commitTime'),
                    'committer': data.get('committer'),
                    'commit_message': data.get('commitMessage'),
                    'commit_label': data.get('commitLabel')
                }
                print(f"   ✅ Pipeline Version: {version_info.get('version', 'N/A')}")
                return version_info
            return None
        except Exception as e:
            print(f"   ⚠️  Could not fetch pipeline version: {e}")
            return None

    def get_job_runtime_info(self, job_details: Dict, job_status: Dict) -> Optional[Dict]:
        """Get job runtime information from job details and status"""
        try:
            print(f"🔍 Extracting job runtime information...")

            if not job_details and not job_status:
                print(f"   ⚠️  No job details or status available")
                return None

            runtime_info = {}

            # Extract from job details
            if job_details:
                runtime_info['job_id'] = job_details.get('id') or job_details.get('jobId')
                runtime_info['job_name'] = job_details.get('name') or job_details.get('jobName')
                runtime_info['pipeline_commit_id'] = job_details.get('pipelineCommitId')
                runtime_info['pipeline_name'] = job_details.get('pipelineName')

            # Extract from job status (this is where most runtime info lives)
            if job_status:
                # Status information
                runtime_info['status'] = job_status.get('status')
                runtime_info['color'] = job_status.get('color')  # e.g., GREEN, RED, YELLOW

                # Timing information
                runtime_info['start_time'] = job_status.get('startTime')
                runtime_info['finish_time'] = job_status.get('finishTime')

                # Metrics from status
                metrics = job_status.get('metrics') or {}
                runtime_info['input_records'] = metrics.get('inputRecordCount', 0)
                runtime_info['output_records'] = metrics.get('outputRecordCount', 0)
                runtime_info['error_records'] = metrics.get('errorRecordCount', 0)

                # Additional useful fields
                runtime_info['run_count'] = job_status.get('runCount')
                runtime_info['executor_count'] = job_status.get('executorCount')

                # Calculate runtime duration
                if runtime_info.get('start_time') and runtime_info.get('finish_time'):
                    try:
                        start_str = runtime_info['start_time']
                        finish_str = runtime_info['finish_time']

                        # Handle different datetime formats (Control Hub sends epoch millis)
                        if isinstance(start_str, (int, float)) and isinstance(finish_str, (int, float)):
                            secs = (finish_str - start_str) / 1000
                            runtime_info['duration_seconds'] = secs
                            runtime_info['duration_formatted'] = str(timedelta(seconds=secs))
                        elif isinstance(start_str, str) and isinstance(finish_str, str):
                            start = datetime.fromisoformat(start_str.replace('Z', '+00:00'))
                            finish = datetime.fromisoformat(finish_str.replace('Z', '+00:00'))
                            duration = finish - start
                            runtime_info['duration_seconds'] = duration.total_seconds()
                            runtime_info['duration_formatted'] = str(duration)
                    except Exception as e:
                        print(f"   ⚠️  Could not calculate duration: {e}")
                        runtime_info['duration_seconds'] = None
                        runtime_info['duration_formatted'] = None

            # Check if we got any meaningful data
            has_data = any([
                runtime_info.get('status'),
                runtime_info.get('start_time'),
                (runtime_info.get('input_records') or 0) > 0
            ])

            if not has_data:
                print(f"   ⚠️  No runtime information available (job may not have run yet)")
                return None

            # Status message
            status = runtime_info.get('status', 'UNKNOWN')
            duration = runtime_info.get('duration_formatted', 'N/A')

            if status in ['ACTIVE', 'RUNNING', 'INACTIVE']:
                print(f"   ✅ Job Status: {status}")
            elif duration != 'N/A':
                print(f"   ✅ Last run: {status} - Duration: {duration}")
            else:
                print(f"   ✅ Job Status: {status}")

            return runtime_info

        except Exception as e:
            print(f"   ⚠️  Error extracting runtime info: {e}")
            import traceback
            traceback.print_exc()
            return None

    def get_pipeline_data(self, identifier: str) -> Dict:
        print(f"\n{'=' * 60}")
        print(f"📦 EXTRACTING PIPELINE: {identifier}")
        print(f"{'=' * 60}")

        print("\n📋 Searching for pipeline...")
        all_pipelines = self.api.request('GET', 'pipelinestore/rest/v1/pipelines')

        pipeline = self._find_match(all_pipelines, identifier, ['pipelineId', 'name', 'title'])
        if not pipeline:
            print(f"❌ Pipeline not found: {identifier}")
            return {}

        pipeline_id = pipeline.get('pipelineId')

        # Fetch pipeline version information
        version_info = self.get_pipeline_version_info(pipeline_id)

        print("📋 Fetching pipeline details...")
        latest_commit = self.api.request('GET', f'pipelinestore/rest/v1/pipeline/{pipeline_id}/latest')

        # no commit/config = empty report; fail the pipeline instead of writing a blank one
        if not isinstance(latest_commit, dict) or not latest_commit.get('commitId'):
            print(f"❌ Could not fetch latest commit for: {identifier}")
            return {}

        commit_id = latest_commit.get('commitId')

        print("📋 Fetching configuration...")
        full_config = self.api.request('GET', f'pipelinestore/rest/v1/pipelineCommit/{commit_id}')
        if not isinstance(full_config, dict) or not full_config.get('pipelineDefinition'):
            print(f"❌ Could not fetch pipeline configuration for: {identifier}")
            return {}

        fragment_stages = self._get_fragment_stages(full_config['pipelineDefinition'])

        print("⚙️  Fetching associated jobs...")
        jobs = self.api.request('GET', 'jobrunner/rest/v1/jobs/forPipelineCommit',
                                params={'pipelineCommitId': commit_id})

        data_collectors = []
        jobs_with_metrics = []

        if jobs:
            print("🖥️  Fetching data collectors from jobs...")
            all_sdcs = self.api.request('GET', 'jobrunner/rest/v1/sdcs')

            if not all_sdcs:
                print("⚠️  Could not fetch SDC list from API")
            else:
                print(f"   Found {len(all_sdcs)} total SDCs in system")

            for job in jobs:
                job_name = job.get('name', 'Unknown')
                job_id = job.get('id')
                print(f"   Checking job: {job_name}")

                sdc_ids = set()

                job_status = job.get('currentJobStatus', {})
                if job_status:
                    status_sdc_ids = job_status.get('sdcIds', [])
                    if status_sdc_ids:
                        print(f"      Found {len(status_sdc_ids)} SDC(s) in currentJobStatus.sdcIds")
                        sdc_ids.update(status_sdc_ids)

                    status_sdc_id = job_status.get('sdcId')
                    if status_sdc_id:
                        print(f"      Found SDC in currentJobStatus.sdcId: {status_sdc_id}")
                        sdc_ids.add(status_sdc_id)

                runs_on = job.get('runsOn')
                if runs_on:
                    print(f"      Found SDC in runsOn: {runs_on}")
                    sdc_ids.add(runs_on)

                executor_id = job.get('executorId')
                if executor_id:
                    print(f"      Found SDC in executorId: {executor_id}")
                    sdc_ids.add(executor_id)

                sdc_list = job.get('sdcList', [])
                if sdc_list:
                    print(f"      Found {len(sdc_list)} SDC(s) in sdcList")
                    for sdc_item in sdc_list:
                        if isinstance(sdc_item, dict):
                            sdc_id = sdc_item.get('id') or sdc_item.get('sdcId')
                            if sdc_id:
                                sdc_ids.add(sdc_id)
                        elif isinstance(sdc_item, str):
                            sdc_ids.add(sdc_item)

                if not sdc_ids:
                    print(f"      ⚠️  No SDCs found for this job")

                for sdc_id in sdc_ids:
                    if any(sdc.get('id') == sdc_id for sdc in data_collectors):
                        continue

                    sdc_info = self._find_match(all_sdcs, sdc_id, ['id'])
                    if sdc_info:
                        data_collectors.append({
                            'id': sdc_info.get('id'),
                            'httpUrl': sdc_info.get('httpUrl'),
                            'labels': sdc_info.get('labels', []),
                            'version': sdc_info.get('sdcVersion'),
                            'state': sdc_info.get('state'),
                            'reported': sdc_info.get('reported'),
                            'used_by_job': job_name
                        })
                        print(f"      ✅ Matched SDC: {sdc_info.get('httpUrl', sdc_id)}")
                    else:
                        print(f"      ⚠️  SDC ID {sdc_id} not found in SDC list")
                        data_collectors.append({
                            'id': sdc_id,
                            'httpUrl': None,
                            'labels': [],
                            'version': None,
                            'state': 'Unknown',
                            'reported': None,
                            'used_by_job': job_name,
                            'status': 'SDC not found in available list'
                        })

                # NEW FUNCTIONALITY: Fetch execution metrics for this job
                if job_id:
                    print(f"      📊 Fetching execution metrics for job: {job_name}")
                    job_metrics = self.get_job_execution_metrics(job_id)

                    # Also fetch runtime info from job details and status
                    job_details_for_runtime = job  # Job object contains details
                    job_status_for_runtime = job.get('currentJobStatus', {})
                    runtime_info = self.get_job_runtime_info(job_details_for_runtime, job_status_for_runtime)

                    job_with_metrics = job.copy()
                    job_with_metrics['execution_metrics'] = job_metrics
                    job_with_metrics['runtime_info'] = runtime_info
                    jobs_with_metrics.append(job_with_metrics)
                else:
                    jobs_with_metrics.append(job)

        if not data_collectors:
            print("⚠️  No data collectors found for this pipeline")
            print("   Possible reasons:")
            print("   - Pipeline has no associated jobs")
            print("   - Jobs are not assigned to any SDC")
            print("   - SDC information not available in job status")
            print("\n   Attempting to fetch all available SDCs as fallback...")

            all_sdcs = self.api.request('GET', 'jobrunner/rest/v1/sdcs')
            if all_sdcs and len(all_sdcs) > 0:
                print(f"   Found {len(all_sdcs)} available SDCs in the system")
                print("   You may need to manually select the correct SDC(s)")

                for sdc in all_sdcs[:5]:
                    data_collectors.append({
                        'id': sdc.get('id'),
                        'httpUrl': sdc.get('httpUrl'),
                        'labels': sdc.get('labels', []),
                        'version': sdc.get('sdcVersion'),
                        'state': sdc.get('state'),
                        'reported': sdc.get('reported'),
                        'used_by_job': 'N/A - Available SDC (not explicitly assigned)',
                        'status': 'Available but not assigned to this pipeline'
                    })

                if len(all_sdcs) > 5:
                    print(f"   (Showing 5 of {len(all_sdcs)} available SDCs)")
            else:
                print("   ❌ Could not fetch any SDCs from the system")

        result = {
            'extraction_time': datetime.now().isoformat(),
            'identifier': identifier,
            'basic_info': pipeline,
            'version_info': version_info,
            'latest_commit': latest_commit,
            'full_configuration': full_config,
            'associated_jobs': jobs_with_metrics if jobs_with_metrics else jobs,
            'data_collectors': data_collectors if data_collectors else None,
            'fragment_stages': fragment_stages
        }

        print("✅ Pipeline extraction complete!")
        return result

    def _get_fragment_stages(self, pipeline_def_str: str) -> Dict[str, List[Dict]]:
        """{fragmentInstanceId: [stages]} for every fragment the pipeline uses. Taken from the
        definition when it carries the fragment, otherwise from the fragment's own commit."""
        try:
            pipeline_def = json.loads(pipeline_def_str)
        except (TypeError, json.JSONDecodeError):
            return {}
        inline = {f.get('fragmentInstanceId'): f.get('stages') for f in pipeline_def.get('fragments') or []
                  if isinstance(f, dict) and f.get('fragmentInstanceId') and f.get('stages')}
        result = {}
        for stage in pipeline_def.get('stages') or []:
            ui = (stage.get('uiInfo') or {}) if isinstance(stage, dict) else {}
            instance_id = ui.get('fragmentInstanceId')
            if not ui.get('fragmentGroupStage') or not instance_id:
                continue
            if inline.get(instance_id):
                result[instance_id] = inline[instance_id]
                continue
            commit = self.api.request('GET', f"pipelinestore/rest/v1/pipelineCommit/{ui.get('pipelineCommitId')}") \
                if ui.get('pipelineCommitId') else None
            try:
                result[instance_id] = json.loads(commit['pipelineDefinition'])['stages']
                print(f"   🧩 Fragment {ui.get('fragmentName', instance_id)}: {len(result[instance_id])} stage(s)")
            except (TypeError, KeyError, json.JSONDecodeError):
                print(f"   ⚠️  Could not load fragment {ui.get('fragmentName', instance_id)} - kept as a single stage")
        return result

    def get_job_execution_metrics(self, job_id: str) -> Dict:
        """Fetch execution metrics for a job including record counts, throughput, and error logs"""
        metrics = {
            'job_metrics': None,
            'record_counts': None,
            'record_throughput': None,
            'status': 'unknown'
        }

        try:
            # Get basic job metrics
            print(f"         Fetching job metrics...")
            job_metrics = self.api.request('GET', f'jobrunner/rest/v1/metrics/job/{job_id}')
            if job_metrics:
                metrics['job_metrics'] = job_metrics
                metrics['status'] = 'success'

                # Extract key information
                if isinstance(job_metrics, dict):
                    metrics['summary'] = {
                        'input_records': job_metrics.get('inputRecords', 0),
                        'output_records': job_metrics.get('outputRecords', 0),
                        'error_records': job_metrics.get('errorRecords', 0),
                        'start_time': job_metrics.get('startTime'),
                        'end_time': job_metrics.get('endTime'),
                        'status': job_metrics.get('status', 'Unknown')
                    }
                print(f"         ✅ Job metrics retrieved")
            else:
                print(f"         ⚠️  No job metrics available")

            # Get time series record counts
            print(f"         Fetching record counts over time...")
            record_counts = self.api.request('GET', f'timeseries/rest/v1/metrics/job/{job_id}/recordCount')
            if record_counts:
                metrics['record_counts'] = record_counts
                print(f"         ✅ Record counts retrieved")
            else:
                print(f"         ⚠️  No record count data available")

            # Get time series throughput
            print(f"         Fetching record throughput over time...")
            throughput = self.api.request('GET', f'timeseries/rest/v1/metrics/job/{job_id}/recordThroughput')
            if throughput:
                metrics['record_throughput'] = throughput
                print(f"         ✅ Record throughput retrieved")
            else:
                print(f"         ⚠️  No throughput data available")

        except Exception as e:
            print(f"         ⚠️  Error fetching execution metrics: {e}")
            metrics['status'] = 'error'
            metrics['error'] = str(e)

        return metrics

    @staticmethod
    def _find_match(items: List[Dict], identifier: str, fields: List[str]) -> Dict:
        for item in items:
            for field in fields:
                if item.get(field) == identifier:
                    return item
        return None


class ParameterResolver:

    @staticmethod
    def extract_parameter_keys(data) -> Set[str]:
        keys = set()
        pattern = re.compile(r'\$\{([^}]+)\}')

        if isinstance(data, dict):
            for value in data.values():
                keys.update(ParameterResolver.extract_parameter_keys(value))
        elif isinstance(data, list):
            for item in data:
                keys.update(ParameterResolver.extract_parameter_keys(item))
        elif isinstance(data, str):
            matches = pattern.findall(data)
            keys.update(matches)

        return keys

    @staticmethod
    def extract_pipeline_stages(data: Dict) -> Dict[str, List[Dict]]:
        pipeline_def = ParameterResolver._get_pipeline_definition(data)

        if not pipeline_def:
            return {'sources': [], 'targets': [], 'events': {}, 'jdbc_table_lists': {}}

        stages = ParameterResolver._expand_fragments(pipeline_def.get('stages', []), data)

        sources = []
        targets = []
        jdbc_table_lists = {}

        for stage in stages:
            if not isinstance(stage, dict):
                continue

            stage_name = stage.get('instanceName', 'Unknown')
            stage_library = stage.get('library', '')
            stage_type = stage.get('stageName', '')
            stage_label = stage.get('uiInfo', {}).get('label', stage_name)

            tech_name = ParameterResolver._extract_technology_name(stage_library, stage_type, stage_label)

            config_details = ParameterResolver._extract_stage_configuration(stage, stage_type, tech_name)

            stage_info = {
                'name': stage_label,
                'technology': tech_name,
                'instance': stage_name,
                'type': stage_type,
                'details': config_details
            }

            # Extract tablePatternList from JDBC sources for jdbc.tables resolution
            stage_config = stage.get('configuration', [])
            for config_item in stage_config:
                if isinstance(config_item, dict):
                    config_name = config_item.get('name', '')
                    config_value = config_item.get('value')

                    if 'tableconfigs' in config_name.lower() and config_value:
                        if isinstance(config_value, list):
                            for table_config in config_value:
                                if isinstance(table_config, dict):
                                    table_pattern_list = table_config.get('tablePatternList')
                                    if table_pattern_list and isinstance(table_pattern_list, list):
                                        if stage_name not in jdbc_table_lists:
                                            jdbc_table_lists[stage_name] = []
                                        jdbc_table_lists[stage_name].extend(table_pattern_list)

            if any(keyword in stage_type.lower() for keyword in
                   ['origin', 'source', 'reader', 'consumer', 'directory', 'tail', 'dsource']):
                sources.append(stage_info)
            elif any(keyword in stage_type.lower() for keyword in
                     ['destination', 'target', 'writer', 'producer', 'executor', 'dtarget']):
                targets.append(stage_info)

        events = ParameterResolver._extract_event_information(pipeline_def)

        return {
            'sources': sources,
            'targets': targets,
            'events': events,
            'jdbc_table_lists': jdbc_table_lists
        }

    @staticmethod
    def _expand_fragments(stages: List[Dict], data: Dict) -> List[Dict]:
        """Swap each fragment group stage for the stages inside it, so a JDBC origin or Snowflake
        destination that lives in a fragment still lands in pipeline_flow. Inner names and ${PARAM}
        refs get the fragment's prefix, the same way Data Collector expands them at runtime.
        A fragment we couldn't fetch stays as the group stage (old behaviour)."""
        fragments = data.get('fragment_stages') or {}
        if not fragments:
            return stages
        param_defs = ParameterResolver.extract_parameter_definitions(data)
        expanded = []
        for stage in stages:
            ui = (stage.get('uiInfo') or {}) if isinstance(stage, dict) else {}
            inner = fragments.get(ui.get('fragmentInstanceId')) if ui.get('fragmentGroupStage') else None
            if not inner:
                expanded.append(stage)
                continue
            instance_id = ui['fragmentInstanceId']
            prefix = ui.get('parameterNamePrefix') or ''

            def prefixed(match, prefix=prefix):
                name = match.group(1)
                return '${' + prefix + name + '}' if prefix and (prefix + name) in param_defs else match.group(0)

            for inner_stage in inner:
                if not isinstance(inner_stage, dict):
                    continue
                copy = json.loads(re.sub(r'\$\{(\w+)\}', prefixed, json.dumps(inner_stage)))
                copy['instanceName'] = f"{instance_id}_{inner_stage.get('instanceName', 'Unknown')}"
                copy.setdefault('uiInfo', {})
                copy['uiInfo']['fragmentName'] = ui.get('fragmentName')
                expanded.append(copy)
        return expanded

    @staticmethod
    def _extract_event_information(pipeline_def: Dict) -> Dict[str, any]:
        events = {
            'start_event': None,
            'stop_event': None,
        }

        start_event_stages = pipeline_def.get('startEventStages', [])
        if start_event_stages:
            events['start_event'] = []
            for stage in start_event_stages:
                if isinstance(stage, dict):
                    stage_name = stage.get('instanceName', 'Unknown')
                    stage_type = stage.get('stageName', 'Unknown')
                    stage_label = stage.get('uiInfo', {}).get('label', stage_name)

                    config = ParameterResolver._extract_stage_configuration(stage, stage_type, 'Event')

                    event_info = {
                        'name': stage_label,
                        'instance': stage_name,
                        'type': stage_type,
                        'configuration': config
                    }
                    events['start_event'].append(event_info)

        stop_event_stages = pipeline_def.get('stopEventStages', [])
        if stop_event_stages:
            events['stop_event'] = []
            for stage in stop_event_stages:
                if isinstance(stage, dict):
                    stage_name = stage.get('instanceName', 'Unknown')
                    stage_type = stage.get('stageName', 'Unknown')
                    stage_label = stage.get('uiInfo', {}).get('label', stage_name)

                    config = ParameterResolver._extract_stage_configuration(stage, stage_type, 'Event')

                    event_info = {
                        'name': stage_label,
                        'instance': stage_name,
                        'type': stage_type,
                        'configuration': config
                    }
                    events['stop_event'].append(event_info)

        return events

    @staticmethod
    def _extract_stage_configuration(stage: Dict, stage_type: str, tech_name: str) -> Dict[str, str]:
        config = {}
        stage_config = stage.get('configuration', [])

        name_mappings = {
            'account': 'Account',
            'database': 'Database',
            'schema': 'Schema',
            'table': 'Table(s)',
            'tablename': 'Table Name',
            'tablenametemplate': 'Table Name Template',
            'warehouse': 'Warehouse',
            'role': 'Role',
            'user': 'User',
            'username': 'Username',
            'password': 'Password',
            'authenticatewith': 'Authentication Method',
            'privatekey': 'Private Key',
            'privatekeypassword': 'Private Key Password',
            'connectionstring': 'Connection String',
            'jdbcconnectionstring': 'JDBC Connection String',
            'url': 'URL',
            'baseurl': 'Base URL',
            'resourceurl': 'Resource URL',
            'httpmethod': 'HTTP Method',
            'host': 'Host',
            'hostname': 'Hostname',
            'port': 'Port',
            'datadir': 'Directory Path',
            'directorypath': 'Directory Path',
            'filepattern': 'File Pattern',
            'filepath': 'File Path',
            'bucket': 'S3 Bucket',
            'prefix': 'S3 Prefix',
            'Connection': 'Connection(s)',
            'commonprefix': 'S3 Common Prefix',
            'region': 'Region',
            'brokeruri': 'Kafka Broker',
            'topic': 'Kafka Topic',
            'consumergroup': 'Consumer Group',
            'dataformat': 'Data Format',
            'compression': 'Compression',
            'query': 'Query',
            'sqlquery': 'SQL Query',
            'statement': 'Statement',
            'collection': 'Collection',
            'accesskey': 'Access Key',
            'accesskeyid': 'Access Key ID',
            'secretkey': 'Secret Key',
            'secretaccesskey': 'Secret Access Key',
            'apikey': 'API Key',
            'apisecret': 'API Secret',
            'token': 'Token',
            'authtoken': 'Auth Token',
            'bearertoken': 'Bearer Token',
            'clientid': 'Client ID',
            'clientsecret': 'Client Secret',
            'headers': 'Headers',
            'requestbody': 'Request Body',
            'requesttimeout': 'Request Timeout',
            'connecttimeout': 'Connect Timeout',
            'maxretries': 'Max Retries',
            'authtype': 'Authentication Type',
            'usessl': 'Use SSL',
            'truststorepath': 'Trust Store Path',
            'truststorepassword': 'Trust Store Password',
            'keystorepath': 'Key Store Path',
            'keystorepassword': 'Key Store Password',
            'proxyhost': 'Proxy Host',
            'proxyport': 'Proxy Port',
            'proxyusername': 'Proxy Username',
            'proxypassword': 'Proxy Password',
            'maxbatchsize': 'Max Batch Size',
            'batchwaittime': 'Batch Wait Time',
            'numberofthreads': 'Number of Threads',
            'charset': 'Character Set',
            'encoding': 'Encoding',
        }

        for config_item in stage_config:
            if not isinstance(config_item, dict):
                continue

            config_name = config_item.get('name', '')
            config_value = config_item.get('value')

            if not config_name or config_value is None:
                continue

            if isinstance(config_value, str) and config_value in ['', 'null', 'None']:
                continue
            if isinstance(config_value, bool) and not config_value:
                continue

            short_name = config_name.split('.')[-1]
            short_name_lower = short_name.lower()

            if short_name_lower in name_mappings:
                display_name = name_mappings[short_name_lower]
            else:
                display_name = short_name.replace('_', ' ').title()

            if isinstance(config_value, (str, int, float)):
                value_str = str(config_value)
                config[display_name] = value_str
            elif isinstance(config_value, bool):
                config[display_name] = str(config_value)
            elif isinstance(config_value, list):
                if len(config_value) > 0:
                    if all(isinstance(v, (str, int, float, bool)) for v in config_value):
                        config[display_name] = ', '.join(str(v) for v in config_value)
                    else:
                        config[display_name] = json.dumps(config_value, indent=2)
            elif isinstance(config_value, dict):
                if config_value:
                    config[display_name] = json.dumps(config_value, indent=2)

        for config_item in stage_config:
            if not isinstance(config_item, dict):
                continue

            config_name = config_item.get('name', '')
            config_value = config_item.get('value')

            if any(keyword in config_name.lower() for keyword in ['query', 'sql', 'statement']):
                if isinstance(config_value, str) and len(config_value) > 20:
                    config['SQL Query/Statement'] = config_value

        return config

    @staticmethod
    def _extract_technology_name(library: str, stage_type: str, label: str) -> str:
        tech_mappings = {
            'snowflake': 'Snowflake',
            'jdbc': 'JDBC/Database',
            'oracle': 'Oracle',
            'sqlserver': 'SQL Server',
            'mysql': 'MySQL',
            'postgresql': 'PostgreSQL',
            'mongodb': 'MongoDB',
            'hadoop': 'Hadoop',
            'hive': 'Hive',
            'kafka': 'Kafka',
            's3': 'Amazon S3',
            'azure': 'Azure',
            'gcs': 'Google Cloud Storage',
            'hdfs': 'HDFS',
            'salesforce': 'Salesforce',
            'elasticsearch': 'Elasticsearch',
            'redis': 'Redis',
            'cassandra': 'Cassandra',
            'kinesis': 'Amazon Kinesis',
            'sqs': 'Amazon SQS',
            'http': 'HTTP Client',
            'rest': 'REST API',
            'file': 'File',
            'localfs': 'Local File System',
            'directory': 'Directory',
            'spooldir': 'Directory',
            'sftp': 'SFTP',
            'ftp': 'FTP',
            'sharepoint': 'SharePoint',
            'windows': 'Windows',
            'tail': 'File Tail',
            'trash': 'Trash',
            'devnull': 'Dev Null',
            'wholefile': 'Whole File',
            'delimited': 'CSV/Delimited',
            'json': 'JSON',
            'xml': 'XML',
            'avro': 'Avro',
            'parquet': 'Parquet',
            'excel': 'Excel',
            'teradata': 'Teradata',
            'sap': 'SAP',
            'mapr': 'MapR',
            'kudu': 'Kudu',
            'omniture': 'Omniture',
            'splunk': 'Splunk'
        }

        library_lower = library.lower()
        for key, value in tech_mappings.items():
            if key in library_lower:
                return value

        stage_type_lower = stage_type.lower()
        for key, value in tech_mappings.items():
            if key in stage_type_lower:
                return value

        label_lower = label.lower()
        for key, value in tech_mappings.items():
            if key in label_lower:
                return value

        if label and label != 'Unknown':
            return label

        if 'jdbc' in stage_type_lower:
            return 'JDBC/Database'
        elif 'file' in stage_type_lower or 'directory' in stage_type_lower:
            return 'File System'
        elif 'http' in stage_type_lower or 'rest' in stage_type_lower:
            return 'HTTP/REST'

        return 'Unknown'

    @staticmethod
    def extract_parameter_definitions(data: Dict) -> Dict[str, str]:
        definitions = {}

        pipeline_def = ParameterResolver._get_pipeline_definition(data)
        if pipeline_def:
            definitions.update(ParameterResolver._extract_from_pipeline_def(pipeline_def))

        job_info = data.get('basic_info', {})
        runtime_params = job_info.get('runtimeParameters', {})
        if isinstance(runtime_params, dict):
            definitions.update({k: str(v) for k, v in runtime_params.items()})

        param_defs = job_info.get('parameterDefinitions', [])
        if isinstance(param_defs, list):
            for param in param_defs:
                if isinstance(param, dict):
                    name = param.get('name') or param.get('key')
                    value = param.get('defaultValue') or param.get('value')
                    if name:
                        definitions[name] = str(value) if value is not None else 'N/A'

        return definitions

    @staticmethod
    def _get_pipeline_definition(data: Dict) -> Dict:
        pipeline_def_str = (data.get('full_configuration') or {}).get('pipelineDefinition')

        if not pipeline_def_str:
            pipeline_def_str = (data.get('associated_pipeline') or {}).get('pipelineDefinition')

        if pipeline_def_str:
            try:
                return json.loads(pipeline_def_str)
            except json.JSONDecodeError:
                pass

        return {}

    @staticmethod
    def _extract_from_pipeline_def(pipeline_def: Dict) -> Dict[str, str]:
        definitions = {}

        constants = pipeline_def.get('constants', {})
        if isinstance(constants, dict):
            definitions.update({k: str(v) for k, v in constants.items()})

        config_array = pipeline_def.get('configuration', [])
        for config_item in config_array:
            if not isinstance(config_item, dict):
                continue

            name = config_item.get('name', '')
            value = config_item.get('value')

            if 'constant' in name.lower() or 'parameter' in name.lower():
                if isinstance(value, list):
                    for item in value:
                        if isinstance(item, dict):
                            key = item.get('key') or item.get('name')
                            val = item.get('value')
                            if key:
                                definitions[key] = str(val) if val is not None else 'N/A'
                elif isinstance(value, dict):
                    definitions.update({k: str(v) for k, v in value.items()})

        return definitions

    @staticmethod
    def resolve_stage_parameters(stage_config: Dict[str, str],
                                 resolved_params: Dict[str, Tuple[str, Optional[str], Optional[str]]],
                                 full_data: Dict = None,
                                 jdbc_table_lists: Dict[str, List[str]] = None) -> Dict[str, str]:
        resolved_config = {}
        param_pattern = re.compile(r'\$\{([^}]+)\}')

        def search_in_json(key: str, data) -> Optional[str]:
            if isinstance(data, dict):
                if key in data:
                    value = data[key]
                    if isinstance(value, (str, int, float, bool)):
                        return str(value)

                for k, v in data.items():
                    result = search_in_json(key, v)
                    if result:
                        return result

            elif isinstance(data, list):
                for item in data:
                    result = search_in_json(key, item)
                    if result:
                        return result

            return None

        # Initialize jdbc_table_lists if not provided
        if jdbc_table_lists is None:
            jdbc_table_lists = {}

        for key, value in stage_config.items():
            # First, try to resolve jdbc.tables placeholders
            value = ParameterResolver.resolve_jdbc_tables_placeholder(value, jdbc_table_lists)

            if not isinstance(value, str):
                resolved_config[key] = value
                continue

            if '${' in value:
                matches = param_pattern.findall(value)

                if matches:
                    resolved_value = value
                    original_value = value
                    all_resolved = True

                    for param_key in matches:
                        param_resolved_value = None

                        if param_key in resolved_params:
                            definition, fetched_value, _ = resolved_params[param_key]

                            if fetched_value is not None and 'runtime:loadResource' in definition:
                                param_resolved_value = fetched_value
                            elif fetched_value is not None:
                                param_resolved_value = fetched_value
                            elif definition and 'runtime:loadResource' not in definition and definition not in ['N/A',
                                                                                                                'None',
                                                                                                                '']:
                                param_resolved_value = definition

                        if param_resolved_value is None and full_data:
                            json_value = search_in_json(param_key, full_data)
                            if json_value:
                                param_resolved_value = json_value

                        if param_resolved_value:
                            resolved_value = resolved_value.replace(f'${{{param_key}}}', param_resolved_value)
                        else:
                            all_resolved = False

                    # JSON values (Tableconfigs etc.) get json.loads'd by the validator - never append notes to them
                    if original_value.lstrip()[:1] in ('[', '{'):
                        resolved_config[key] = resolved_value
                    elif resolved_value != original_value:
                        if all_resolved:
                            resolved_config[key] = resolved_value
                        else:
                            resolved_config[
                                key] = f"{resolved_value} (some parameters unresolved from: {original_value})"
                    else:
                        resolved_config[key] = f"{value} (unable to resolve)"
                else:
                    resolved_config[key] = value
            else:
                resolved_config[key] = value

        return resolved_config

    @staticmethod
    def resolve_jdbc_tables_placeholder(value: str, jdbc_table_lists: Dict[str, List[str]]) -> any:
        """
        Resolves ${record:attribute('jdbc.tables')} placeholders with actual table names from JDBC sources.
        Returns either the original string, a list of resolved strings, or resolved string.
        """
        # Pattern to match ${record:attribute('jdbc.tables')}
        pattern = r'\$\{record:attribute\([\'"]jdbc\.tables[\'"]\)\}'

        if not isinstance(value, str) or not re.search(pattern, value):
            return value

        # Get all table names from all JDBC sources
        all_tables = []
        for table_list in jdbc_table_lists.values():
            if isinstance(table_list, list):
                all_tables.extend(table_list)

        if not all_tables:
            return value  # No tables found, return original

        # Split the value into parts around the placeholder
        parts = re.split(pattern, value)

        if len(parts) < 2:
            return value

        prefix = parts[0]
        suffix = parts[1] if len(parts) > 1 else ""

        # Create resolved versions for each table
        resolved_values = [f"{prefix}{table}{suffix}" for table in all_tables]

        # Return as a formatted string showing all resolved values
        return "\n          ".join(resolved_values)


_SECRET_RE = re.compile(r'passw|pwd|passphrase|secret|private ?key|token|api ?key|access ?key', re.I)


def _mask_secrets(obj, secret=False):
    """Mask credentials before they hit the report file. Covers {'Password': x}, {'name': '..password', 'value': x}
    and parameter entries keyed like DB_PASSWORD. ${PARAM} references are kept so the report stays readable."""
    if isinstance(obj, dict):
        if not secret and ('value' in obj or 'definition' in obj):
            secret = bool(_SECRET_RE.search(str(obj.get('name') or obj.get('key') or '')))
        return {k: v if k in ('name', 'key', 'parameter') else _mask_secrets(v, secret or bool(_SECRET_RE.search(k)))
                for k, v in obj.items()}
    if isinstance(obj, list):
        return [_mask_secrets(v, secret) for v in obj]
    if secret and isinstance(obj, str) and obj and not obj.startswith('${'):
        return '********'
    return obj


class FileManager:

    @staticmethod
    def build_report_data(param_keys: Set[str],
                          resolved_params: Dict[str, Tuple[str, Optional[str], Optional[str]]],
                          identifier: str,
                          data_collectors: List[Dict] = None,
                          pipeline_stages: Dict[str, List[Dict]] = None,
                          full_data: Dict = None,
                          stage_data: Dict = None,
                          pipeline_name: str = None,
                          pipeline_number: int = None) -> Dict:
        """Build the report data structure without saving to file."""

        # Extract jdbc_table_lists from pipeline_stages
        jdbc_table_lists = {}
        if pipeline_stages:
            jdbc_table_lists = pipeline_stages.get('jdbc_table_lists', {})

        params_with_resolved = []
        params_with_definition = []
        params_without_definition = []

        for key in param_keys:
            if key in resolved_params:
                definition, resolved_value, source_sdc = resolved_params[key]
                if resolved_value is not None:
                    params_with_resolved.append((key, definition, resolved_value, source_sdc))
                else:
                    params_with_definition.append((key, definition))
            else:
                params_without_definition.append(key)

        # Build JSON structure
        report = {}

        # Add pipeline number and name at the top level if provided
        if pipeline_number is not None:
            report["pipeline_number"] = pipeline_number
        if pipeline_name:
            report["pipeline_name"] = pipeline_name

        report.update({
            "metadata": {
                "identifier": pipeline_name if pipeline_name else identifier,
                "pipeline_id": identifier,
                "extraction_type": full_data.get('extraction_type', 'unknown') if full_data else 'unknown',
                "generated_timestamp": datetime.now().isoformat(),
                "server_url": Config.BASE_URL,
                "username": Config.USERNAME
            },
            "version_info": full_data.get('version_info') if full_data else None,
            "runtime_info": full_data.get('runtime_info') if full_data else None,
            "summary": {
                "total_parameters": len(param_keys),
                "parameters_with_resolved_values": len(params_with_resolved),
                "parameters_with_definitions": len(params_with_definition),
                "parameters_without_definitions": len(params_without_definition),
                "data_collectors_count": len(data_collectors) if data_collectors else 0
            },
            "pipeline_flow": {},
            "parameters": {}
        })

        # Add execution metrics summary if available
        if full_data and 'execution_metrics' in full_data:
            exec_metrics = full_data['execution_metrics']
            if exec_metrics.get('summary'):
                report['summary']['execution_summary'] = exec_metrics['summary']

        # Add count of jobs with metrics for pipelines
        if full_data and 'associated_jobs' in full_data:
            jobs = full_data['associated_jobs']
            if jobs:
                report['summary']['jobs_with_metrics'] = len([j for j in jobs if 'execution_metrics' in j])

        # Add pipeline flow information
        if pipeline_stages:
            sources = pipeline_stages.get('sources', [])
            targets = pipeline_stages.get('targets', [])

            sources_list = []
            if sources:
                for source in sources:
                    details = source.get('details', {})
                    resolved_details = ParameterResolver.resolve_stage_parameters(
                        details, resolved_params, full_data, jdbc_table_lists
                    ) if details else {}

                    source_info = {
                        "technology": source.get('technology', 'Unknown'),
                        "stage_name": source.get('name', 'Unknown'),
                        "instance": source.get('instance', 'Unknown'),
                        "type": source.get('type', 'Unknown'),
                        "configuration": resolved_details
                    }
                    sources_list.append(source_info)

            targets_list = []
            if targets:
                for target in targets:
                    details = target.get('details', {})
                    resolved_details = ParameterResolver.resolve_stage_parameters(
                        details, resolved_params, full_data, jdbc_table_lists
                    ) if details else {}

                    target_info = {
                        "technology": target.get('technology', 'Unknown'),
                        "stage_name": target.get('name', 'Unknown'),
                        "instance": target.get('instance', 'Unknown'),
                        "type": target.get('type', 'Unknown'),
                        "configuration": resolved_details
                    }
                    targets_list.append(target_info)

            report["pipeline_flow"] = {
                "sources": sources_list,
                "targets": targets_list
            }

        # FILTERED OUT: pipeline_events (not required in output)
        # FILTERED OUT: data_collectors (not required in output)

        # Add parameters information
        params_resolved_list = []
        if params_with_resolved:
            for key, definition, resolved_value, source_sdc in sorted(params_with_resolved):
                param_info = {
                    "parameter": "${" + key + "}",
                    "key": key,
                    "definition": definition,
                    "resolved_value": resolved_value
                }
                if source_sdc:
                    param_info["source_sdc"] = source_sdc
                params_resolved_list.append(param_info)

        params_defined_list = []
        if params_with_definition:
            for key, definition in sorted(params_with_definition):
                params_defined_list.append({
                    "parameter": "${" + key + "}",
                    "key": key,
                    "definition": definition
                })

        params_undefined_list = []
        if params_without_definition:
            for key in sorted(params_without_definition):
                params_undefined_list.append({
                    "parameter": "${" + key + "}",
                    "key": key,
                    "note": "NOT DEFINED - May be runtime/environment variable"
                })

        all_definitions = {}
        if resolved_params:
            for key, (definition, resolved_value, source_sdc) in sorted(resolved_params.items()):
                def_entry = {
                    "definition": definition
                }
                if resolved_value:
                    def_entry["resolved_value"] = resolved_value
                    if source_sdc:
                        def_entry["source_sdc"] = source_sdc
                all_definitions[key] = def_entry

        report["parameters"] = {
            "with_resolved_values": params_resolved_list,
            "with_definitions": params_defined_list,
            "without_definitions": params_undefined_list,
            "all_definitions": all_definitions
        }

        # FILTERED OUT: execution_metrics (not required in output)
        # FILTERED OUT: jobs_execution_metrics (not required in output)

        # Add jobs runtime info if this is a pipeline report (KEEPING THIS)
        if full_data and 'associated_jobs' in full_data:
            jobs = full_data['associated_jobs']
            jobs_runtime = []

            for job in jobs:
                # Add runtime info for each job
                if 'runtime_info' in job and job['runtime_info']:
                    jobs_runtime.append({
                        'job_name': job.get('name', 'Unknown'),
                        'job_id': job.get('id'),
                        'runtime_info': job['runtime_info']
                    })

            if jobs_runtime:
                report["jobs_runtime_info"] = jobs_runtime

        # FILTERED OUT: pipeline_version_info (not required in output)

        # Add pipeline stages section if available
        if stage_data:
            report["pipeline_stages"] = stage_data

        return _mask_secrets(report)

    @staticmethod
    def create_output_dir(directory: str):
        Path(directory).mkdir(parents=True, exist_ok=True)

class StageExtractor:
    """Handles detailed stage extraction with summaries and commit information"""

    def __init__(self, api_client: StreamSetsAPIClient):
        self.api = api_client

    def generate_stage_summary(self, stage):
        # one odd stage (null/non-dict config value) must not drop pipeline_stages for the whole pipeline
        try:
            return self._stage_summary(stage)
        except Exception as e:
            return f"{stage.get('stageName', 'Unknown')} (summary unavailable: {e})"

    def _stage_summary(self, stage):
        """
        Generate a human-readable summary of what a stage does based on its configuration.
        Works for both regular stages and stages within fragments.
        """
        if not isinstance(stage, dict):
            return "Invalid stage data"

        stage_name = stage.get('stageName', '')
        instance_name = stage.get('instanceName', 'Unknown')
        config = stage.get('configuration', [])

        # Expression Evaluator
        if 'ExpressionDProcessor' in stage_name or 'expression' in stage_name.lower():
            expressions = []
            for conf in config:
                if conf.get('name') == 'expressionProcessorConfigs':
                    for expr in conf.get('value', []):
                        field = expr.get('fieldToSet', '')
                        expression = expr.get('expression', '')
                        if field and expression:
                            expressions.append(f"{field} = {expression}")

            if expressions:
                return f"Expression Evaluator: Sets {len(expressions)} field(s) - " + "; ".join(expressions)
            else:
                return "Expression Evaluator: No expressions configured"

        # Field Replacer
        elif 'FieldReplacer' in stage_name or 'fieldreplacer' in stage_name.lower():
            rules = []
            for conf in config:
                if 'rules' in conf.get('name', '').lower():
                    for rule in conf.get('value', []):
                        fields = rule.get('fields', '')
                        replacement = rule.get('replacement', '')
                        set_to_null = rule.get('setToNull', False)

                        if fields:
                            if set_to_null:
                                rules.append(f"Sets '{fields}' to NULL")
                            elif replacement:
                                rules.append(f"Replaces '{fields}' with '{replacement}'")

            if rules:
                return f"Field Replacer: " + "; ".join(rules)
            else:
                return "Field Replacer: No rules configured"

        # Field Mapper
        elif 'FieldMapper' in stage_name or 'fieldmapper' in stage_name.lower():
            details = []
            operate_on = None
            mappings = []

            for conf in config:
                conf_name = conf.get('name', '')

                if 'operateOn' in conf_name:
                    operate_on = conf.get('value', 'Unknown')
                elif 'fieldMapperConfig.mappingExpression' in conf_name:
                    mapping_expr = conf.get('value', '')
                    if mapping_expr:
                        details.append(f"Expression: {mapping_expr}")
                elif 'fieldMapperConfig.aggregationExpression' in conf_name:
                    agg_expr = conf.get('value', '')
                    if agg_expr:
                        details.append(f"Aggregation: {agg_expr}")
                elif 'fieldMapperConfig.structureChangeAllowed' in conf_name:
                    if conf.get('value'):
                        details.append("Structure changes allowed")
                elif 'fieldMapperConfig.maintainOriginalPaths' in conf_name:
                    if conf.get('value'):
                        details.append("Maintains original paths")

            summary_parts = ["Field Mapper"]
            if operate_on:
                summary_parts.append(f"operates on '{operate_on}'")
            if details:
                summary_parts.append(" - " + "; ".join(details))

            return ": ".join(summary_parts) if len(summary_parts) > 1 else "Field Mapper"

        # Field Renamer
        elif 'FieldRenamer' in stage_name or 'renamer' in stage_name.lower():
            renames = []
            for conf in config:
                if 'renameMapping' in conf.get('name', ''):
                    for mapping in conf.get('value', []):
                        from_field = mapping.get('fromFieldExpression', '')
                        to_field = mapping.get('toFieldExpression', '')
                        if from_field and to_field:
                            renames.append(f"'{from_field}' → '{to_field}'")

            if renames:
                return f"Field Renamer: " + "; ".join(renames)
            else:
                return "Field Renamer: No renames configured"

        # Field Type Converter
        elif 'FieldTypeConverter' in stage_name or 'typeconverter' in stage_name.lower():
            conversions = []
            for conf in config:
                if 'fieldTypeConverterConfigs' in conf.get('name', ''):
                    for conv in conf.get('value', []):
                        fields = conv.get('fields', [])
                        target_type = conv.get('targetType', '')
                        if fields and target_type:
                            for field in fields:
                                conversions.append(f"'{field}' → {target_type}")

            if conversions:
                return f"Field Type Converter: " + "; ".join(conversions)
            else:
                return "Field Type Converter: No conversions configured"

        # Stream Selector
        elif 'StreamSelector' in stage_name or 'selector' in stage_name.lower():
            conditions = []
            for conf in config:
                if 'lanePredicates' in conf.get('name', ''):
                    for pred in conf.get('value', []):
                        output_lane = pred.get('outputLane', '')
                        predicate = pred.get('predicate', '')
                        if predicate:
                            conditions.append(f"Lane '{output_lane}': {predicate}")

            if conditions:
                return f"Stream Selector: Routes based on conditions - " + "; ".join(conditions)
            else:
                return "Stream Selector: Routes records based on conditions"

        # Stream Filter
        elif 'filter' in stage_name.lower():
            predicates = []
            for conf in config:
                if 'predicate' in conf.get('name', '').lower():
                    pred = conf.get('value', '')
                    if pred:
                        predicates.append(pred)

            if predicates:
                return f"Filter: " + "; ".join(predicates)
            else:
                return "Filter: Filters records based on predicates"

        # Aggregator
        elif 'aggregat' in stage_name.lower():
            agg_expressions = []
            for conf in config:
                if 'aggregatorConfigs' in conf.get('name', ''):
                    for agg in conf.get('value', []):
                        name = agg.get('aggregationTitle', '')
                        expression = agg.get('aggregationExpression', '')
                        if name and expression:
                            agg_expressions.append(f"{name}: {expression}")

            if agg_expressions:
                return f"Aggregator: " + "; ".join(agg_expressions)
            else:
                return "Aggregator: Aggregates data"

        # Joiner
        elif 'joiner' in stage_name.lower() or 'join' in stage_name.lower():
            join_type = None
            join_condition = None

            for conf in config:
                conf_name = conf.get('name', '')
                if 'joinType' in conf_name:
                    join_type = conf.get('value', '')
                elif 'joinCondition' in conf_name:
                    join_condition = conf.get('value', '')

            parts = ["Joiner"]
            if join_type:
                parts.append(f"Type: {join_type}")
            if join_condition:
                parts.append(f"Condition: {join_condition}")

            return " - ".join(parts)

        # Field Pivoter
        elif 'pivoter' in stage_name.lower() or 'pivot' in stage_name.lower():
            return "Field Pivoter: Pivots field data"

        # Field Flattener
        elif 'flattener' in stage_name.lower() or 'flatten' in stage_name.lower():
            return "Field Flattener: Flattens nested structures"

        # Jython/JavaScript Evaluator
        elif 'jython' in stage_name.lower() or 'javascript' in stage_name.lower() or 'groovy' in stage_name.lower():
            script = None
            for conf in config:
                if 'script' in conf.get('name', '').lower():
                    script = conf.get('value', '')
                    break

            lang = "Script"
            if 'jython' in stage_name.lower():
                lang = "Jython"
            elif 'javascript' in stage_name.lower():
                lang = "JavaScript"
            elif 'groovy' in stage_name.lower():
                lang = "Groovy"

            if script and len(script) > 100:
                return f"{lang} Evaluator: Custom script ({len(script)} characters)"
            elif script:
                return f"{lang} Evaluator: {script}"
            else:
                return f"{lang} Evaluator: Custom processing"

        # Fragment Processor
        elif 'FragmentProcessor' in stage_name:
            fragment_id = None
            fragment_instance = None

            for conf in config:
                conf_name = conf.get('name', '')
                if 'fragmentId' in conf_name:
                    fragment_id = conf.get('value', '')
                elif 'fragmentInstanceId' in conf_name:
                    fragment_instance = conf.get('value', '')

            ui_info = stage.get('uiInfo', {})
            fragment_name = ui_info.get('fragmentName', fragment_id or 'Unknown')

            return f"Fragment Processor: '{fragment_name}' (instance: {fragment_instance or 'N/A'})"

        # Generic fallback
        else:
            # Extract a readable name from the stage name
            readable_name = stage_name.split('_')[-1].replace('DProcessor', '').replace('Processor', '')

            # Try to get description from uiInfo
            ui_info = stage.get('uiInfo', {})
            description = ui_info.get('description', '')

            if description:
                return f"{readable_name}: {description}"
            else:
                return f"{readable_name} processor"

    def fetch_pipeline_commit_info(self, pipeline_commit_id, stage_instance_name):
        """Fetch additional configuration information using a pipeline commit ID."""
        if not pipeline_commit_id:
            return None

        try:
            print(f"         📥 Fetching commit info for: {stage_instance_name}")
            commit_data = self.api.request('GET', f'pipelinestore/rest/v1/pipelineCommit/{pipeline_commit_id}')

            if not commit_data:
                print(f"         ⚠️  Could not fetch commit data")
                return None

            commit_info = {
                'commit_id': commit_data.get('commitId'),
                'pipeline_id': commit_data.get('pipelineId'),
                'name': commit_data.get('name'),
                'title': commit_data.get('title'),
                'version': commit_data.get('version'),
                'description': commit_data.get('description'),
                'created': commit_data.get('created'),
                'lastModified': commit_data.get('lastModified'),
                'creator': commit_data.get('creator'),
                'lastModifier': commit_data.get('lastModifier')
            }

            pipeline_def_str = commit_data.get('pipelineDefinition')
            if pipeline_def_str:
                try:
                    pipeline_def = json.loads(pipeline_def_str)
                    commit_info['pipeline_definition'] = {
                        'uuid': pipeline_def.get('uuid'),
                        'schemaVersion': pipeline_def.get('schemaVersion'),
                        'version': pipeline_def.get('version'),
                        'pipelineId': pipeline_def.get('pipelineId'),
                        'title': pipeline_def.get('title'),
                        'description': pipeline_def.get('description'),
                        'configuration': pipeline_def.get('configuration'),
                        'uiInfo': pipeline_def.get('uiInfo'),
                        'stages_count': len(pipeline_def.get('stages', [])),
                        'stages': pipeline_def.get('stages', [])
                    }
                    print(f"         ✅ Successfully fetched commit with {len(pipeline_def.get('stages', []))} stages")
                except json.JSONDecodeError as e:
                    print(f"         ⚠️  Could not parse pipeline definition: {e}")
            else:
                print(f"         ⚠️  No pipeline definition in commit")

            return commit_info

        except Exception as e:
            print(f"         ❌ Error fetching commit info: {e}")
            return None

    def generate_fragment_summary(self, commit_info):
        """Generate a human-readable summary of what a fragment does based on its stages."""
        if not commit_info or 'pipeline_definition' not in commit_info:
            return "No summary available"

        pipeline_def = commit_info['pipeline_definition']
        stages = pipeline_def.get('stages', [])

        if not stages:
            return "Empty fragment - no stages found"

        summaries = []
        for stage in stages:
            summary = self.generate_stage_summary(stage)
            summaries.append(summary)

        if len(summaries) == 1:
            return summaries[0]
        else:
            return " → ".join(summaries)

    def enrich_stage_with_commit_info(self, stage):
        """Enrich a stage with additional information from its pipeline commit ID."""
        if not isinstance(stage, dict):
            return stage

        ui_info = stage.get('uiInfo', {})
        pipeline_commit_id = ui_info.get('pipelineCommitId')

        if pipeline_commit_id:
            instance_name = stage.get('instanceName', 'Unknown')
            print(f"      🔍 Processing stage: {instance_name}")

            commit_info = self.fetch_pipeline_commit_info(pipeline_commit_id, instance_name)

            if commit_info:
                summary = self.generate_fragment_summary(commit_info)
                commit_info['fragment_summary'] = summary
                stage['enriched_commit_info'] = commit_info
                print(f"      ✅ Enriched stage with commit information")
                print(f"      📝 Summary: {summary}")

        return stage

    def add_stage_summary(self, stage):
        """Add a summary to any stage (not just fragment processors)."""
        if not isinstance(stage, dict):
            return stage

        summary = self.generate_stage_summary(stage)
        stage['stage_summary'] = summary

        return stage

    def extract_stages_data(self, pipeline_identifier: str):
        """Extract detailed stage information with summaries - returns dict to be added to main report"""
        try:
            print("\n🔍 Extracting detailed stage information...")

            # Find the pipeline
            all_pipelines = self.api.request('GET', 'pipelinestore/rest/v1/pipelines')
            pipeline = None
            for p in all_pipelines:
                if (p.get('pipelineId') == pipeline_identifier or
                        p.get('name') == pipeline_identifier or
                        p.get('title') == pipeline_identifier):
                    pipeline = p
                    break

            if not pipeline:
                print(f"   ⚠️  Could not find pipeline for stage extraction")
                return None

            pipeline_id = pipeline.get('pipelineId')
            pipeline_name = pipeline.get('name') or pipeline.get('title')

            # Get latest commit
            latest_commit = self.api.request('GET', f'pipelinestore/rest/v1/pipeline/{pipeline_id}/latest')
            if not latest_commit:
                return None

            commit_id = latest_commit.get('commitId')
            version = latest_commit.get('version')

            # Get full pipeline configuration
            full_config = self.api.request('GET', f'pipelinestore/rest/v1/pipelineCommit/{commit_id}')
            if not full_config:
                return None

            # Parse pipeline definition
            pipeline_def_str = full_config.get('pipelineDefinition')
            if not pipeline_def_str:
                return None

            try:
                pipeline_def = json.loads(pipeline_def_str)
                print("   ✅ Pipeline definition parsed successfully")
            except json.JSONDecodeError as e:
                print(f"   ❌ Failed to parse pipeline definition: {e}")
                return None

            # Extract stages
            stages = pipeline_def.get('stages', [])
            print(f"   ✅ Found {len(stages)} total stages in pipeline")

            if not stages:
                print("   ❌ No stages found in this pipeline")
                return None

            # Categorize stages
            print("   📋 Categorizing and processing stages...")
            sources = []
            processors = []
            targets = []
            other = []

            for stage in stages:
                if not isinstance(stage, dict):
                    continue

                stage_name = stage.get('stageName', '').lower()

                if any(keyword in stage_name for keyword in
                       ['origin', 'source', 'reader', 'consumer', 'directory', 'tail', 'dsource']):
                    sources.append(stage)
                elif any(keyword in stage_name for keyword in
                         ['destination', 'target', 'writer', 'producer', 'executor', 'dtarget']):
                    targets.append(stage)
                elif any(keyword in stage_name for keyword in
                         ['processor', 'evaluator', 'converter', 'parser', 'aggregator', 'filter']):
                    processors.append(stage)
                else:
                    other.append(stage)

            print(f"   ✅ Categorization complete")

            # Enrich stages with commit information
            print(f"   📋 Enriching stages with commit information...")
            enriched_processors = []
            for stage in processors:
                enriched_stage = self.enrich_stage_with_commit_info(stage)
                enriched_processors.append(enriched_stage)

            enriched_other = []
            for stage in other:
                enriched_stage = self.enrich_stage_with_commit_info(stage)
                enriched_other.append(enriched_stage)

            print(f"   ✅ Stage enrichment complete")

            # Add summaries to ALL stages
            print(f"   📋 Generating summaries for all stages...")
            all_enriched_stages = enriched_processors + enriched_other

            for stage in all_enriched_stages:
                self.add_stage_summary(stage)

            print(f"   ✅ Generated summaries for {len(all_enriched_stages)} stages")

            # Generate comprehensive summaries list
            print(f"   📋 Compiling comprehensive stage summaries...")
            all_stage_summaries = []

            for stage in all_enriched_stages:
                instance_name = stage.get('instanceName', 'Unknown')
                stage_summary = stage.get('stage_summary', 'No summary')
                stage_type = stage.get('uiInfo', {}).get('stageType', 'UNKNOWN')

                summary_entry = {
                    'instance_name': instance_name,
                    'stage_type': stage_type,
                    'summary': stage_summary
                }

                # If it's a fragment, add fragment details
                if 'enriched_commit_info' in stage:
                    fragment_name = stage.get('uiInfo', {}).get('fragmentName', 'Unknown Fragment')
                    fragment_summary = stage['enriched_commit_info'].get('fragment_summary', 'No summary')

                    summary_entry['is_fragment'] = True
                    summary_entry['fragment_name'] = fragment_name
                    summary_entry['fragment_summary'] = fragment_summary
                else:
                    summary_entry['is_fragment'] = False

                all_stage_summaries.append(summary_entry)

            print(f"   ✅ Compiled {len(all_stage_summaries)} stage summaries")

            output_data = {
                "pipeline_stage_info": {
                    "pipeline_name": pipeline_name,
                    "pipeline_id": pipeline_id,
                    "commit_id": commit_id,
                    "version": version,
                    "extraction_time": datetime.now().strftime('%Y-%m-%d %H:%M:%S')
                },
                "stage_summary": {
                    "total_stages": len(stages),
                    "sources_excluded": len(sources),
                    "processors_included": len(processors),
                    "targets_excluded": len(targets),
                    "other_included": len(other),
                    "stages_extracted": len(processors) + len(other),
                    "stages_enriched_with_commit_info": sum(
                        1 for s in all_enriched_stages if 'enriched_commit_info' in s),
                    "stages_with_summaries": len(all_stage_summaries)
                },
                "stage_summaries": all_stage_summaries,
                "stages": {
                    "processors": enriched_processors,
                    "other": enriched_other
                }
            }

            return output_data

        except Exception as e:
            print(f"   ⚠️  Error extracting stages: {e}")
            import traceback
            traceback.print_exc()
            return None


class StreamSetsExtractor:

    def __init__(self):
        self.api_client = StreamSetsAPIClient(Config.BASE_URL, Config.USERNAME, Config.PASSWORD)
        self.data_extractor = DataExtractor(self.api_client)
        self.param_resolver = ParameterResolver()
        self.file_manager = FileManager()
        self.stage_extractor = StageExtractor(self.api_client)

        # Fetch all SDCs and initialize ResourceResolver with connection pool
        sdc_list = self.api_client.get_all_sdcs()
        self.resource_resolver = ResourceResolver(sdc_list, Config.USERNAME, Config.PASSWORD)

    def cleanup(self):
        """Close all SDC connections."""
        self.resource_resolver.close_all_connections()

    def filter_insight_pipelines(self, pipelines: List[Dict]) -> List[Dict]:
        """Filter pipelines that contain 'insight' in their name (case-insensitive)."""
        insight_pipelines = [p for p in pipelines if 'insight' in (p.get('name') or '').lower()]
        print(f"   🎯 Filtered {len(insight_pipelines)} insight pipeline(s)")
        return insight_pipelines

    def extract_all_insight_pipelines(self, selected: Optional[List[str]] = None, output_path: Optional[str] = None):
        """Extract every insight pipeline, or just `selected` (ids or names), in parallel."""
        print("\n" + "=" * 60)
        print("🚀 EXTRACTING ALL INSIGHT PIPELINES")
        print("=" * 60)

        # Fetch all pipelines
        all_pipelines = self.data_extractor.get_all_pipelines()
        if not all_pipelines:
            print("\n❌ No pipelines found. Exiting.")
            return False

        missing = []
        if selected:
            # picked by hand: any pipeline by id or name, not only "insight" ones
            wanted = list(dict.fromkeys(selected))
            insight_pipelines = [p for p in all_pipelines if p.get('pipelineId') in wanted or p.get('name') in wanted]
            found = {p.get('pipelineId') for p in insight_pipelines} | {p.get('name') for p in insight_pipelines}
            missing = [w for w in wanted if w not in found]
            for w in missing:
                print(f"❌ Pipeline not found: {w}")
            print(f"   🎯 Selected {len(insight_pipelines)} pipeline(s)")
        else:
            insight_pipelines = self.filter_insight_pipelines(all_pipelines)

        if not insight_pipelines:
            print("\n⚠️  No insight pipelines found. Exiting.")
            return False

        print(f"\n📊 Starting extraction of {len(insight_pipelines)} insight pipeline(s)...")
        print(f"⚡ Using {Config.THREAD_POOL_SIZE} parallel workers")
        print("=" * 60)

        def extract_single_pipeline(pipeline_info):
            """Extract a single pipeline and return the result."""
            pipeline_name = pipeline_info.get('name', 'Unknown')
            pipeline_id = pipeline_info.get('pipelineId', pipeline_info.get('id', 'Unknown'))

            try:
                print(f"🔄 Processing: {pipeline_name}")
                data = self.data_extractor.get_pipeline_data(pipeline_id)

                if not data:
                    return None, pipeline_name, "Failed to fetch pipeline data"

                # Extract all the information
                # fragment internals use unprefixed names - counting them would list bogus 'undefined' params
                param_keys = self.param_resolver.extract_parameter_keys(
                    {k: v for k, v in data.items() if k != 'fragment_stages'})
                param_defs = self.param_resolver.extract_parameter_definitions(data)
                pipeline_stages = self.param_resolver.extract_pipeline_stages(data)
                data_collectors = data.get('data_collectors', None)

                # Resolve resources
                resolved_params = self.resource_resolver.resolve_all_parameters(param_defs)

                # Extract stage data
                stage_data = self.stage_extractor.extract_stages_data(pipeline_id)

                pipeline_report = self.file_manager.build_report_data(
                    param_keys, resolved_params, pipeline_id,
                    data_collectors, pipeline_stages, data, stage_data,
                    pipeline_name=pipeline_name
                )

                print(f"✅ Successfully extracted: {pipeline_name}")
                return pipeline_report, pipeline_name, None

            except Exception as e:
                error_msg = str(e)
                print(f"❌ Failed to extract {pipeline_name}: {error_msg}")
                import traceback
                traceback.print_exc()
                return None, pipeline_name, error_msg

        reports, failures = [], []
        with ThreadPoolExecutor(max_workers=Config.THREAD_POOL_SIZE) as executor:
            futures = [executor.submit(extract_single_pipeline, p) for p in insight_pipelines]
            for future in as_completed(futures):
                pipeline_report, pipeline_name, error = future.result()
                if pipeline_report:
                    reports.append(pipeline_report)
                else:
                    failures.append((pipeline_name, error))

        # same order + numbering every run (as_completed order is random)
        reports.sort(key=lambda r: r.get('pipeline_name') or '')
        reports = [{"pipeline_number": i, **r} for i, r in enumerate(reports, 1)]

        print("\n" + "=" * 60)
        print("📊 EXTRACTION COMPLETE")
        print("=" * 60)
        print(f"✅ Successful: {len(reports)}")
        failures += [(w, "Pipeline not found") for w in missing]
        print(f"❌ Failed: {len(failures)}")
        for name, error in failures:
            print(f"   - {name}: {error}")

        if not reports:
            print("❌ Nothing extracted - report file not written")
            return False

        # write to a temp file then swap, so a crash never leaves a half-written/invalid JSON behind
        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        output_filepath = output_path or os.path.join(Config.OUTPUT_DIR, f"ALL_INSIGHTS_PIPELINE_REPORT_{timestamp}.json")
        self.file_manager.create_output_dir(os.path.dirname(os.path.abspath(output_filepath)))
        tmp_path = output_filepath + '.tmp'
        with open(tmp_path, 'w', encoding='utf-8') as f:
            json.dump(reports, f, indent=2, ensure_ascii=False)
        os.replace(tmp_path, output_filepath)

        print(f"📁 Output file: {output_filepath}")
        print("=" * 60)
        return not failures


def main():
    """Extract all insight pipelines, or only the ones passed with --pipeline."""
    import argparse
    parser = argparse.ArgumentParser(description='StreamSets pipeline extractor')
    parser.add_argument('--pipeline', nargs='+', metavar='ID_OR_NAME',
                        help='only these pipelines (id or exact name); default is every insight pipeline')
    parser.add_argument('--output', help='write the report to this file instead of output_dir')
    args = parser.parse_args()

    print("\n" + "=" * 60)
    print("🚀 STREAMSETS INSIGHT PIPELINE EXTRACTOR")
    print("=" * 60)
    print(f"\n🔗 Server: {Config.BASE_URL}")
    print(f"👤 User: {Config.USERNAME}")
    print(f"📁 Output Directory: {Config.OUTPUT_DIR}")
    print(f"⏱️  Request Timeout: {Config.REQUEST_TIMEOUT}s")
    print(f"🔄 Thread Pool Size: {Config.THREAD_POOL_SIZE}")
    print(f"📡 Resource Resolution: SSH/SFTP Connection Pool (port 22)")
    print("=" * 60)

    extractor = StreamSetsExtractor()
    try:
        ok = extractor.extract_all_insight_pipelines(args.pipeline, args.output)
    finally:
        extractor.cleanup()
    # non-zero exit so the scheduler/orchestration sees partial or total failure
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()