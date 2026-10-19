export type PositionSide = 'long' | 'short';
export type MarginType = 'cross' | 'isolated';

export interface PositionStop {
  price: number;
  kind: 'algo' | 'order';
}

export interface PositionView {
  symbol: string;
  side: PositionSide;
  /** Tamaño absoluto en unidades base. */
  size: number;
  entry: number;
  mark: number;
  liq: number | null;
  leverage: number;
  marginType: MarginType;
  uPnl: number;
  breakEven: number | null;
  notional: number;
  stop: PositionStop | null;
  firstFillMs: number | null;
}

export interface AccountSnapshot {
  fetchedAt: number;
  equity: number | null;
  dailyPnl: number | null;
  positions: PositionView[];
  fundingRate: number | null;
  nextFundingMs: number | null;
}

export interface Fill {
  symbol: string;
  side: 'BUY' | 'SELL';
  price: number;
  qty: number;
  fee: number;
  realizedPnl: number;
  timeMs: number;
  orderId: string;
}

export interface IncomeRow {
  symbol: string;
  incomeType: string;
  income: number;
  asset: string;
  timeMs: number;
}

export interface ClosedTrade {
  symbol: string;
  side: PositionSide;
  openedMs: number;
  closedMs: number;
  entry: number;
  exit: number;
  size: number;
  pnl: number;
  fees: number;
}

export type AccountErrorCode = 'no_key' | 'ip_or_perm' | 'clock' | 'net' | `http_${number}`;
