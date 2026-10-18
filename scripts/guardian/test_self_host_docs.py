import os
import unittest
import plistlib
import re

class TestSelfHostDocs(unittest.TestCase):
    def setUp(self):
        # Base path of the repository
        self.repo_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        self.doc_path = os.path.join(self.repo_root, "docs", "SELF_HOST.md")

        with open(self.doc_path, 'r', encoding='utf-8') as f:
            self.doc_content = f.read()

        guardian_py_path = os.path.join(self.repo_root, "scripts", "guardian", "risk_guardian.py")
        with open(guardian_py_path, 'r', encoding='utf-8') as f:
            self.guardian_py_content = f.read()

    def test_doc_exists_and_contains_sections(self):
        """Asegura que el documento exista y contenga las secciones requeridas."""
        self.assertTrue(os.path.exists(self.doc_path))
        self.assertIn("Linux", self.doc_content)
        self.assertIn("macOS", self.doc_content)
        self.assertIn("Windows", self.doc_content)
        self.assertIn("Termux", self.doc_content)

    def test_repo_paths_in_backticks_exist(self):
        """Asegura que todas las rutas citadas entre backticks (scripts/, docs/, etc.) existan."""
        paths = re.findall(r'`(scripts/[^`]+|docs/[^`]+|packages/[^`]+|radar/[^`]+)`', self.doc_content)
        for path in paths:
            full_path = os.path.join(self.repo_root, path)
            self.assertTrue(os.path.exists(full_path), f"La ruta {path} mencionada en {self.doc_path} no existe en el repositorio.")

    def test_guardian_env_vars_exist(self):
        """Asegura que todas las variables GUARDIAN_* mencionadas estén en risk_guardian.py."""
        env_vars = set(re.findall(r'GUARDIAN_[A-Z_]+', self.doc_content))
        for env_var in env_vars:
            self.assertIn(env_var, self.guardian_py_content, f"La variable {env_var} mencionada no se encuentra en risk_guardian.py.")

    def test_macos_plist_parses(self):
        """Asegura que el ejemplo de plist en macOS se parsea correctamente y contiene KeepAlive."""
        plist_match = re.search(r'```xml\n(.*?)```', self.doc_content, re.DOTALL)
        self.assertIsNotNone(plist_match, "No se encontró el bloque de código XML (plist) en macOS.")
        plist_str = plist_match.group(1)

        try:
            plist_dict = plistlib.loads(plist_str.encode('utf-8'))
        except Exception as e:
            self.fail(f"El ejemplo de plist no se parsea: {e}")

        self.assertTrue(plist_dict.get('KeepAlive', False), "El plist de ejemplo no contiene 'KeepAlive: true'.")
        self.assertTrue(plist_dict.get('RunAtLoad', False), "El plist de ejemplo no contiene 'RunAtLoad: true'.")

    def test_no_secrets_in_doc(self):
        """Asegura que no haya tokens alfanuméricos de 32 caracteres o más (posibles secretos)."""
        secrets = re.findall(r'[A-Za-z0-9]{32,}', self.doc_content)
        self.assertEqual(len(secrets), 0, "Se encontraron posibles tokens o secretos de 32+ caracteres en el documento.")

    def test_doc_mentions_read_only_and_enforce(self):
        """Asegura que el documento mencione que es 'solo lectura' y sobre 'ENFORCE'."""
        self.assertTrue(re.search(r'read-only|solo lectura', self.doc_content, re.IGNORECASE), "El documento no menciona 'read-only' o 'solo lectura'.")
        self.assertIn("ENFORCE", self.doc_content, "El documento no menciona 'ENFORCE'.")

if __name__ == '__main__':
    unittest.main()
