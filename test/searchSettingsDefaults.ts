import { DEFAULT_SEARCH_SETTINGS } from "../shared/searchSettings";

export const searchSettingsDefaults = () => ({ debounce: DEFAULT_SEARCH_SETTINGS.searchOnTypeDebouncePeriod, mode: DEFAULT_SEARCH_SETTINGS.defaultViewMode, collapse: DEFAULT_SEARCH_SETTINGS.collapseResults });
