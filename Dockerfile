# UNA SOLA IMAGEN PARA TODOS LOS COMPONENTES
# ----------------------------------------------------------------------------
# Decision de arquitectura: construimos UNA imagen y cada servicio del compose
# la arranca con un CMD distinto. Ventajas para la demo:
#   - Build rapido y reproducible (los profesores corren un solo `docker compose up`).
#   - Demuestra el principio de CONTENEDOR INMUTABLE: la misma imagen corre en
#     todos lados, lo unico que cambia son las variables de entorno.
#   - Al escalar (`--scale queue=3`) las 3 replicas son binariamente identicas.
# En un proyecto real cada componente tendria su propia imagen para poder
# desplegarse de forma independiente (facilidad de despliegue).
FROM node:20-alpine

WORKDIR /app

# Copiamos primero el manifiesto: si no cambia, Docker reusa la capa de
# node_modules en cache y el build es mucho mas rapido.
COPY package.json ./
RUN npm install --omit=dev

# Recien ahora el codigo (cambia seguido, va en la capa de arriba).
COPY src ./src

# No corremos como root: principio de menor privilegio (seguridad/proteccion).
USER node

EXPOSE 3000

# CMD por defecto; el docker-compose.yml lo sobreescribe por servicio.
CMD ["node", "src/services/auth/index.js"]