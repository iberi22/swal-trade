import unittest
import subprocess
import os
import tempfile
import stat
import shutil

class TestInstallLinuxServices(unittest.TestCase):
    def setUp(self):
        self.maxDiff = None
        self.tmp_dir = tempfile.mkdtemp()
        self.repo_dir = os.path.join(self.tmp_dir, "repo")
        os.makedirs(self.repo_dir)
        self.dest_dir = os.path.join(self.tmp_dir, "dest")
        os.makedirs(self.dest_dir)

        self.home_dir = os.path.join(self.tmp_dir, "home")
        os.makedirs(self.home_dir)
        self.env = os.environ.copy()
        self.env["HOME"] = self.home_dir

        # Create mock repo structure
        os.makedirs(os.path.join(self.repo_dir, "packages/mcp/scripts"))
        os.makedirs(os.path.join(self.repo_dir, "radar"))
        os.makedirs(os.path.join(self.repo_dir, "scripts/guardian"))

        with open(os.path.join(self.repo_dir, "packages/mcp/scripts/swal-bridge.service"), "w") as f:
            f.write("[Service]\nWorkingDirectory=%h/proyectosSWAL/synapse/swal-trade/packages/mcp\nExecStart=/run/current-system/sw/bin/node dist/bridge.js\n")

        with open(os.path.join(self.repo_dir, "radar/swal-radar.service.in"), "w") as f:
            f.write("[Service]\nWorkingDirectory=@REPO_DIR@\nEnvironmentFile=-@ENV_FILE@\n")

        with open(os.path.join(self.repo_dir, "scripts/guardian/risk-guardian.service"), "w") as f:
            f.write("[Service]\nWorkingDirectory=%h/swal-trade\nEnvironmentFile=%h/.config/risk-guardian.env\n")

        self.script_path = os.path.abspath("scripts/install-linux-services.sh")

    def tearDown(self):
        shutil.rmtree(self.tmp_dir)

    def run_script(self, args, check=True, extra_env=None):
        env = self.env.copy()
        if extra_env:
            env.update(extra_env)
        cmd = ["bash", self.script_path] + args + ["--repo-dir", self.repo_dir]
        result = subprocess.run(cmd, env=env, capture_output=True, text=True)
        if check and result.returncode != 0:
            print("STDOUT:", result.stdout)
            print("STDERR:", result.stderr)
            result.check_returncode()
        return result

    def test_help_exit_zero(self):
        """Test --help exits 0"""
        res = self.run_script(["--help"])
        self.assertEqual(res.returncode, 0)
        self.assertIn("Usage: install-linux-services.sh", res.stdout)

    def test_print_default(self):
        """Test --print output has 3 services"""
        res = self.run_script(["--print"])
        self.assertEqual(res.returncode, 0)
        services_count = res.stdout.count("[Service]")
        self.assertEqual(services_count, 3)
        self.assertIn("### Service: bridge", res.stdout)
        self.assertIn("### Service: radar", res.stdout)
        self.assertIn("### Service: guardian", res.stdout)

    def test_print_no_placeholders(self):
        """Test placeholders are replaced"""
        res = self.run_script(["--print"])
        self.assertEqual(res.returncode, 0)
        self.assertNotIn("@REPO_DIR@", res.stdout)
        self.assertNotIn("@ENV_FILE@", res.stdout)
        self.assertNotIn("%h/proyectosSWAL", res.stdout)

    def test_print_no_personal_paths(self):
        """Test no leaked home paths"""
        res = self.run_script(["--print"], extra_env={"HOME": "/tmp/h"})
        self.assertEqual(res.returncode, 0)
        self.assertNotIn("/home/", res.stdout)
        self.assertIn("%h/.config/swal-trade/radar.env", res.stdout)

    def test_install_writes_three_files(self):
        """Test --install writes units"""
        self.run_script(["--install", "--dest", self.dest_dir])
        files = os.listdir(self.dest_dir)
        self.assertEqual(len(files), 3)
        self.assertIn("swal-bridge.service", files)
        self.assertIn("swal-radar.service", files)
        self.assertIn("risk-guardian.service", files)

    def test_install_without_force_skips(self):
        """Test --install without force skips existing"""
        test_file = os.path.join(self.dest_dir, "swal-bridge.service")
        with open(test_file, "w") as f:
            f.write("EXISTING CONTENT")
        res = self.run_script(["--install", "--dest", self.dest_dir])
        self.assertIn("Skipped existing unit file", res.stdout)
        with open(test_file, "r") as f:
            self.assertEqual(f.read(), "EXISTING CONTENT")

        res2 = self.run_script(["--install", "--dest", self.dest_dir, "--force"])
        self.assertIn("Installed unit file", res2.stdout)
        with open(test_file, "r") as f:
            self.assertNotEqual(f.read(), "EXISTING CONTENT")

    def test_install_creates_env_files(self):
        """Test env files created with correct mode"""
        self.run_script(["--install", "--dest", self.dest_dir])
        radar_env = os.path.join(self.home_dir, ".config/swal-trade/radar.env")
        guardian_env = os.path.join(self.home_dir, ".config/risk-guardian.env")

        self.assertTrue(os.path.exists(radar_env))
        self.assertTrue(os.path.exists(guardian_env))

        self.assertEqual(stat.S_IMODE(os.stat(radar_env).st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(os.stat(guardian_env).st_mode), 0o600)

        with open(radar_env, "r") as f:
            content = f.read()
            self.assertIn("#BINANCE_API_KEY=", content)
            self.assertNotIn("API_KEY=xyz", content)

    def test_install_keeps_existing_env_files(self):
        """Test existing env file kept intact"""
        radar_env_dir = os.path.join(self.home_dir, ".config/swal-trade")
        os.makedirs(radar_env_dir, exist_ok=True)
        radar_env = os.path.join(radar_env_dir, "radar.env")
        with open(radar_env, "w") as f:
            f.write("CUSTOM_VAR=123")
        os.chmod(radar_env, 0o644)

        self.run_script(["--install", "--dest", self.dest_dir])

        with open(radar_env, "r") as f:
            self.assertEqual(f.read(), "CUSTOM_VAR=123")
        self.assertEqual(stat.S_IMODE(os.stat(radar_env).st_mode), 0o644)

    def test_enable_prints_commands_if_no_systemctl(self):
        """Test enable without systemctl prints manual commands"""
        # We need bash to run the script. Let's create a PATH that has bash, cat, etc. but not systemctl.
        env = self.env.copy()
        mock_bin_dir = os.path.join(self.tmp_dir, "mock_bin")
        os.makedirs(mock_bin_dir, exist_ok=True)

        # Symlink necessary tools to our mock bin
        for tool in ["bash", "cat", "dirname", "pwd", "mkdir", "echo", "chmod"]:
            tool_path = shutil.which(tool)
            if tool_path:
                os.symlink(tool_path, os.path.join(mock_bin_dir, tool))

        res = self.run_script(["--install", "--enable", "--dest", self.dest_dir], extra_env={"PATH": mock_bin_dir})
        self.assertIn("systemctl not found. To enable services, run:", res.stdout)
        self.assertIn("systemctl --user daemon-reload", res.stdout)
        self.assertIn("loginctl enable-linger", res.stdout)

    def test_only_flag(self):
        """Test --only flag works"""
        res = self.run_script(["--print", "--only", "bridge"])
        self.assertEqual(res.returncode, 0)
        self.assertIn("### Service: bridge", res.stdout)
        self.assertNotIn("### Service: radar", res.stdout)
        self.assertNotIn("### Service: guardian", res.stdout)

if __name__ == "__main__":
    unittest.main()
