# Resultados del script 15 (disponibilidad)

`disponibilidad-tfu4.txt` y `disponibilidad-tfu5.txt` son la salida de
`scripts/15-disponibilidad.sh` contra cada rama, con records-service pausado.

Condiciones de la corrida incluida: maquina Linux, componentes como procesos
locales (PostgreSQL 16, dos Redis 7 y Node 22) en vez de contenedores, y la
pausa de records emulada con SIGSTOP/SIGCONT, que equivale a
`docker compose pause`. Para regenerarlas con Docker, ver el README principal:
cada corrida sobrescribe el archivo de su rama. Los valores absolutos de
latencia van a cambiar; la diferencia de disponibilidad (0% contra 100%) no
depende del entorno.
