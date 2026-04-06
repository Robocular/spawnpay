const COMMISSION_RATES = [0.15, 0.05, 0.02]; // L1, L2, L3

export function buildReferralChain(db, referralCode) {
  const referrer = db.prepare('SELECT id, referral_chain FROM agents WHERE referral_code = ?').get(referralCode);
  if (!referrer) return [];
  const parentChain = JSON.parse(referrer.referral_chain || '[]');
  return [referrer.id, ...parentChain].slice(0, 3);
}

export function calculateCommissions(platformFee, chain) {
  return chain.map((agentId, i) => ({
    agentId,
    level: i + 1,
    amount: Math.floor(platformFee * COMMISSION_RATES[i] * 1e6) / 1e6,
  })).filter(c => c.amount > 0);
}

export function creditReferrals(db, txId, commissions, balanceColumn = 'credit_balance') {
  const creditStmt = db.prepare(`UPDATE agents SET ${balanceColumn} = ${balanceColumn} + ?, referral_earned = referral_earned + ? WHERE id = ?`);
  const logStmt = db.prepare('INSERT INTO referral_payouts (tx_id, referrer_id, level, amount) VALUES (?, ?, ?, ?)');

  const credit = db.transaction(() => {
    for (const c of commissions) {
      creditStmt.run(c.amount, c.amount, c.agentId);
      logStmt.run(txId, c.agentId, c.level, c.amount);
    }
  });
  credit();
}

export function validateReferralCode(db, code, newAgentId) {
  if (!code) return { valid: false, reason: 'no code' };
  const referrer = db.prepare('SELECT id, referral_chain FROM agents WHERE referral_code = ?').get(code);
  if (!referrer) return { valid: false, reason: 'code not found' };
  if (referrer.id === newAgentId) return { valid: false, reason: 'self-referral' };
  const chain = JSON.parse(referrer.referral_chain || '[]');
  if (chain.includes(newAgentId)) return { valid: false, reason: 'circular chain' };
  return { valid: true, referrer };
}

export function getReferralStats(db, agentId) {
  const agent = db.prepare('SELECT referral_code, referral_earned FROM agents WHERE id = ?').get(agentId);
  if (!agent) return null;
  const direct = db.prepare("SELECT COUNT(*) as count FROM agents WHERE referred_by = ?").get(agent.referral_code);
  const l2 = db.prepare("SELECT COUNT(*) as count FROM agents WHERE referred_by IN (SELECT referral_code FROM agents WHERE referred_by = ?)").get(agent.referral_code);
  const l3 = db.prepare("SELECT COUNT(*) as count FROM agents WHERE referred_by IN (SELECT referral_code FROM agents WHERE referred_by IN (SELECT referral_code FROM agents WHERE referred_by = ?))").get(agent.referral_code);
  return {
    referralCode: agent.referral_code,
    directReferrals: direct.count,
    level2Referrals: l2.count,
    level3Referrals: l3.count,
    totalEarned: agent.referral_earned,
  };
}
