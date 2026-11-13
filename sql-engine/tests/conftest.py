import json
import sys
from pathlib import Path

import pytest

ENGINE_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = ENGINE_ROOT.parent
if str(ENGINE_ROOT) not in sys.path:
    sys.path.insert(0, str(ENGINE_ROOT))


@pytest.fixture(scope="session")
def fixtures_path() -> Path:
    return REPO_ROOT / "test" / "fixtures" / "dialect_conversions.json"


@pytest.fixture(scope="session")
def conversion_cases(fixtures_path: Path):
    with fixtures_path.open("r", encoding="utf-8") as handle:
        data = json.load(handle)
    return data["cases"]
