-- +goose Up
-- The days a day plan ran for. Housekeeping plans a business day by itself once, when billing's
-- night audit opens it or on start when the current one has none; a supervisor's plan marks the day
-- too. A day that already holds a planned stayover counts as planned.
CREATE TABLE housekeeping.planned_days (
    day date PRIMARY KEY
);

INSERT INTO housekeeping.planned_days (day) SELECT DISTINCT day FROM housekeeping.planned_stayovers;

-- +goose Down
DROP TABLE housekeeping.planned_days;
