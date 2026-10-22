-- The s.api.ir IsHoliday web service answers only about today, so it is no longer used for the calendar:
-- official holidays are added from the bundled list instead. Its answer cache and date-format setting go.
DROP TABLE IF EXISTS holiday_lookups;
DROP TABLE IF EXISTS app_settings;
