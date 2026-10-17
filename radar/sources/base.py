from abc import ABC, abstractmethod
from typing import List, Dict, Any

class BaseSource(ABC):
    name: str = 'base'

    @abstractmethod
    def scan(self, symbol: str, timeframe: str, candles: list) -> List[Dict[str, Any]]:
        pass
