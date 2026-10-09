// Cuenta de solo lectura: pérdida del día por encima del límite y BTC sin stop.
// ETH tiene stop, para distinguir el plan gratis (solo vigila el mayor nocional) del Pro.

export function accountPayload() {
  return {
    positions: [
      {
        symbol: 'BTCUSDT',
        positionAmt: '0.01',
        notional: '5000',
        unrealizedProfit: '-80',
        positionSide: 'BOTH',
      },
      {
        symbol: 'ETHUSDT',
        positionAmt: '1',
        notional: '2000',
        unrealizedProfit: '-10',
        positionSide: 'BOTH',
      },
    ],
  };
}

export function positionRiskPayload() {
  return [
    { symbol: 'BTCUSDT', positionAmt: '0.01', leverage: '10', entryPrice: '50000', unRealizedProfit: '-80' },
    { symbol: 'ETHUSDT', positionAmt: '1', leverage: '5', entryPrice: '2000', unRealizedProfit: '-10' },
  ];
}

export function incomePayload(now = Date.now()) {
  return [{ incomeType: 'REALIZED_PNL', asset: 'USDT', income: '-40', time: now }];
}

export function algoPayload() {
  return [
    {
      symbol: 'ETHUSDT',
      side: 'SELL',
      orderType: 'STOP_MARKET',
      closePosition: true,
      positionSide: 'BOTH',
    },
  ];
}

export function apiRestrictionsPayload() {
  return {
    ipRestrict: false,
    enableReading: true,
    enableWithdrawals: false,
    enableInternalTransfer: false,
    enableFutures: false,
    enableSpotAndMarginTrading: false,
  };
}
