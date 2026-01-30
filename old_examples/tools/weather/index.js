// Weather tool - mock implementation
export const weather = {
  /**
   * Get weather information for a city
   * @param {string} city - City name
   * @returns {string} Weather information
   */
  getWeather(city) {
    // Mock weather data
    const mockData = {
      'Krasnodar': 'в Краснодаре малооблачно, +18°C. По ощущению +18°C, Ветер 3 м/c.',
      'Moscow': 'в Москве пасмурно, +5°C. По ощущению +2°C, Ветер 7 м/c.',
      'London': 'в Лондоне дождь, +12°C. По ощущению +10°C, Ветер 5 м/c.',
      'New York': 'в Нью-Йорке солнечно, +22°C. По ощущению +22°C, Ветер 2 м/c.'
    };

    const weather = mockData[city] || `в городе ${city} данные о погоде недоступны (заглушка)`;
    return weather;
  }
};

