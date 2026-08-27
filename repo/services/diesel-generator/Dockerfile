# Maakt een image met Alpine als basis
# Alpine is heel klein en snel
FROM node:20-alpine
# De werkmap voor de volgende stappen en het draaiende proces
# Als het nog niet bestaat wordt het aangemaakt. 
WORKDIR /app
# Kopieer alle content naar /app
COPY . .
# Deze gebruiker bestaat al in de basis-image.
# Zonder die regel draait de container standaard als root 
USER node
# Start node rechtstreeks, waardoor node PID 1 is. 
# Als we dit niet doen en bv (CMD node server.js) zouden gebruiken,
# Dan is /bin/sh PID 1 en node een childprocess. 
# SIGTERM zou dan naar sh gaan en niet naar node. 
CMD ["node", "server.js"]