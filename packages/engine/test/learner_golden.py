"""Golden values for packages/engine/test/learner.test.ts.

elevate's learner is L2-regularised logistic regression (prior precision 1, prior mean 0 for features it
has no prior for) with per-example weights, plus a Laplace posterior. In sklearn terms that is
LogisticRegression(C=1, fit_intercept=False) with sample_weight, and the posterior sd of w'x is
sqrt(x' H^-1 x) with H = X' diag(c p (1-p)) X + I, the construction LogisticUCB uses in
github.com/david-cortes/contextualbandits.
"""

import json
import warnings

import numpy as np
from sklearn.linear_model import LogisticRegression

PRIOR_PRECISION = 1.0

X = np.array(
    [
        [1, 0, 1, 0],
        [1, 1, 0, 0],
        [1, 0, 0, 1],
        [1, 1, 1, 0],
        [1, 0, 1, 1],
        [1, 1, 0, 1],
        [1, 0.5, 0.2, 0],
        [1, -0.3, 0.8, 0.4],
        [1, 1, 1, 1],
        [1, 0, 0, 0],
    ],
    dtype=float,
)
y = np.array([1, 0, 1, 0, 1, 0, 1, 0, 1, 0])
c = np.array([1, 1, 0.5, 1, 1, 0.5, 1, 1, 0.5, 1], dtype=float)

with warnings.catch_warnings():
    warnings.simplefilter("ignore")
    clf = LogisticRegression(C=1 / PRIOR_PRECISION, fit_intercept=False, solver="lbfgs", tol=1e-12, max_iter=100000)
    clf.fit(X, y, sample_weight=c)
w = clf.coef_[0]

# Independent check: Newton's method on the same objective.
v = np.zeros(4)
for _ in range(100):
    p = 1 / (1 + np.exp(-X @ v))
    g = X.T @ (c * (y - p)) - PRIOR_PRECISION * v
    H = X.T @ (X * (c * p * (1 - p))[:, None]) + PRIOR_PRECISION * np.eye(4)
    v = v + np.linalg.solve(H, g)
assert np.max(np.abs(v - w)) < 1e-6, (v, w)

p = 1 / (1 + np.exp(-X @ w))
H = X.T @ (X * (c * p * (1 - p))[:, None]) + PRIOR_PRECISION * np.eye(4)
S = np.linalg.inv(H)

queries = [[1, 0, 1, 0], [1, 1, 0, 0], [0.5, -1, 0.3, 2]]
out = {
    "w": w.tolist(),
    "newton_max_diff": float(np.max(np.abs(v - w))),
    "queries": [{"x": q, "mean": float(np.dot(q, w)), "sd": float(np.sqrt(np.dot(q, S @ q)))} for q in queries],
    # f0 = 1 plus a feature the model never saw (prior mean 0, prior variance 1).
    "unseen": {"mean": float(w[0]), "sd": float(np.sqrt(S[0, 0] + 1 / PRIOR_PRECISION))},
}
print(json.dumps(out, indent=1))
