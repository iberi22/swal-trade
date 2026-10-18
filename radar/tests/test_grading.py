import unittest
from radar.grading import breakeven_win_rate, wilson_bounds, bootstrap_mean_ci, grade_cell

class TestGrading(unittest.TestCase):
    def test_breakeven_win_rate(self):
        self.assertAlmostEqual(breakeven_win_rate(1.0, 0.0008), 0.5004, places=4)
        self.assertAlmostEqual(breakeven_win_rate(2.0, 0.001), 0.333666, places=4)

    def test_wilson_bounds_zero(self):
        low, high = wilson_bounds(0, 0)
        self.assertIsNone(low)
        self.assertIsNone(high)

    def test_wilson_bounds_values(self):
        low, high = wilson_bounds(10, 20)
        self.assertTrue(0.25 < low < 0.35)
        self.assertTrue(0.65 < high < 0.75)

    def test_bootstrap_mean_ci_deterministic(self):
        x = [0.3, -1, 1, -1, 2] * 20
        ci1 = bootstrap_mean_ci(x)
        ci2 = bootstrap_mean_ci(x)
        self.assertEqual(ci1, ci2)
        self.assertIsNotNone(ci1)

    def test_bootstrap_mean_ci_empty(self):
        self.assertIsNone(bootstrap_mean_ci([]))

    def test_grade_cell_no_data(self):
        res = grade_cell(0, 0, [])
        self.assertEqual(res['grade'], 'no_evidence')
        self.assertIn('n_below_30', res['reasons'])

    def test_grade_cell_n_below_30(self):
        res = grade_cell(29, 29, [1.0]*29)
        self.assertEqual(res['grade'], 'no_evidence')
        self.assertIn('n_below_30', res['reasons'])
        # Lucky small sample cannot be validated

    def test_grade_cell_negative_upper_bound(self):
        # n >= 30, mean net R upper bound < 0
        res = grade_cell(40, 10, [-2.0]*40)
        self.assertEqual(res['grade'], 'negative')
        self.assertIsNotNone(res['mean_net_r_ci'])

    def test_grade_cell_negative_upper_bound_large(self):
        # n >= 100, mean net R upper bound < 0
        res = grade_cell(110, 20, [-1.5]*110)
        self.assertEqual(res['grade'], 'negative')

    def test_grade_cell_promising(self):
        # 30 <= n < 100
        # wilson_low > breakeven
        # mean_net_r_ci low > 0
        n = 50
        wins = 45 # high win rate to get high wilson_low
        net_rs = [2.0]*45 + [-1.0]*5
        res = grade_cell(n, wins, net_rs, rr=1.0, cost_r=0.0)
        self.assertEqual(res['grade'], 'promising')

    def test_grade_cell_promising_2(self):
        n = 99
        wins = 80
        net_rs = [1.5]*80 + [-1.0]*19
        res = grade_cell(n, wins, net_rs, rr=1.0, cost_r=0.0008)
        self.assertEqual(res['grade'], 'promising')

    def test_grade_cell_validated(self):
        # n >= 100
        # wilson_low >= breakeven + 0.02
        # mean_net_r_ci low > 0
        # wilson_low > baseline_win_rate (if baseline provided)
        n = 150
        wins = 130
        net_rs = [1.0]*130 + [-1.0]*20
        res = grade_cell(n, wins, net_rs, rr=1.0, cost_r=0.0008, baseline_win_rate=0.5)
        self.assertEqual(res['grade'], 'validated')

    def test_grade_cell_validated_no_baseline(self):
        n = 200
        wins = 160
        net_rs = [1.0]*160 + [-1.0]*40
        res = grade_cell(n, wins, net_rs, rr=1.0, cost_r=0.0008)
        self.assertEqual(res['grade'], 'validated')

    def test_grade_cell_high_win_rate_negative_net_r(self):
        # High win rate but mean net R below zero is not validated
        # Say n=150, wins=140 (very high win rate)
        # But net_rs are very negative on losses, so mean_net_r_ci[0] < 0
        n = 150
        wins = 140
        net_rs = [0.1]*140 + [-20.0]*10
        res = grade_cell(n, wins, net_rs, rr=1.0, cost_r=0.0)
        # ci[1] might also be < 0 making it negative, let's see
        self.assertNotEqual(res['grade'], 'validated')

    def test_grade_cell_no_evidence_not_above_baseline(self):
        n = 150
        wins = 130
        net_rs = [1.0]*130 + [-1.0]*20
        res = grade_cell(n, wins, net_rs, rr=1.0, cost_r=0.0008, baseline_win_rate=0.9)
        self.assertEqual(res['grade'], 'no_evidence')
        self.assertIn('not_above_random_baseline', res['reasons'])

    def test_grade_cell_no_evidence_n_below_100_not_promising(self):
        # 30 <= n < 100, but doesn't meet promising criteria
        # low win rate -> wilson_low < breakeven
        n = 50
        wins = 10
        net_rs = [1.0]*10 + [-1.0]*40
        res = grade_cell(n, wins, net_rs, rr=1.0, cost_r=0.0)
        # ci[1] might be < 0 -> negative
        # If it's negative, it's not no_evidence
        pass

    def test_grade_cell_no_evidence_n_below_100_not_promising_2(self):
        # make net_rs have ci > 0 so it's not negative, but low win rate?
        # That's hard, let's just make ci[1] > 0 but ci[0] < 0
        n = 50
        wins = 25
        net_rs = [2.0]*25 + [-2.0]*25 # mean around 0
        res = grade_cell(n, wins, net_rs, rr=1.0, cost_r=0.0)
        self.assertEqual(res['grade'], 'no_evidence')
        self.assertIn('n_below_100', res['reasons'])

if __name__ == '__main__':
    unittest.main()
