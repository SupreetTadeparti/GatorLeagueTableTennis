import { createApp } from 'vue'
import './style.css'
import App from './App.vue'
import { router } from './router.js'

createApp(App).use(router).mount('#app')

/*
The app is made for a table tennis league and should record data of users/players, their name, their rating (similar to chess elo), their profile picture which is optional. They can participate in biweekly tournaments that alternate between singles and doubles. So there's basically monthly singles and monthly doubles with a 2 week difference in offset. Players can pair up with another player that they are locked with for the season to play doubles and that doubles pair will have their own rating and optional photo. They can also have a team name. All these singles and doubles tournaments run each season which lasts basically a school year. Based on how far you can get in the tournament, you get an appropriate number of points that reset every season.
*/