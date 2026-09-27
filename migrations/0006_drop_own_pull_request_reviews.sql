-- Reviews synced before the reviewed-by search excluded the login's own pull
-- requests include every reply the login left on a review thread there.
-- `pull_requests` holds the pull requests the login authored, so it names the
-- rows to drop without the login appearing here.
DELETE FROM reviews
WHERE EXISTS (
  SELECT 1
  FROM pull_requests
  WHERE pull_requests.repository_id = reviews.repository_id
    AND pull_requests.number = reviews.pull_request_number
);
