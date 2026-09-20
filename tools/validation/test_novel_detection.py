import unittest
import numpy as np

from tools.validation.novel_detection import novel_masks, distance_score, metrics, paired_groups


class NovelDetectionTests(unittest.TestCase):
    def test_prior_detection_excludes_extinguished_cells_and_unknown_is_not_clear(self):
        channels = [name for b in range(6) for name in
                    (f'past_bin{b}_fire_fraction', f'past_bin{b}_observable_fraction')]
        x = np.zeros((1, 12, 1, 4))
        x[0, 1, 0, :3] = 1
        x[0, 0, 0, 0] = 1  # Earlier fire, now clear: not new.
        x[0, 10, 0, 1] = 1  # Latest fire: not new either.
        old = np.array([[[0, 1, 0, 0]]])
        masks, _ = novel_masks(x, old, channels)
        np.testing.assert_array_equal(masks['latest_clear'], [[[True, False, True, False]]])
        np.testing.assert_array_equal(masks['no_past_detection'], [[[False, False, True, False]]])

    def test_distance_baseline_has_fixed_decay_and_handles_no_fire(self):
        p = distance_score(np.array([[True, False, False]]))
        np.testing.assert_allclose(p, [[1, np.exp(-.5), np.exp(-1)]])
        self.assertEqual(distance_score(np.zeros((2, 2), bool)).sum(), 0)

    def test_negative_episodes_remain_in_error_metrics(self):
        m = metrics(np.array([False, False]), {'model': np.array([.6, .2])})
        self.assertIsNone(m['model']['ap'])
        self.assertEqual(m['model']['negative_fpr_05'], .5)
        self.assertAlmostEqual(m['model']['brier'], .2)

    def test_bootstrap_weights_groups_equally_not_pixels_or_episode_counts(self):
        def row(group, score):
            return {'group': group, 'metrics': {'model': {'ap': score}, 'base': {'ap': .2}}}
        result = paired_groups([row('a', .8)] * 50 + [row('b', .2)], 'base')
        self.assertEqual(result['groups'], 2)
        self.assertAlmostEqual(result['mean'], .3)


if __name__ == '__main__':
    unittest.main()
