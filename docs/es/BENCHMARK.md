Read in English: [docs/BENCHMARK.md](../BENCHMARK.md)

# Qué tan bien encuentra las cosas la recuperación

La búsqueda de BrainAI se mide con LoCoMo, una prueba pública de memoria sobre conversaciones largas
([snap-research/locomo](https://github.com/snap-research/locomo), Maharana et al., 2024, CC BY-NC 4.0). Sus diez
conversaciones llegan a unos 600 turnos cada una, a lo largo de muchas semanas, con preguntas sobre lo que se dijo.

> Estas pruebas parten de datos que ya están guardados. No demuestran que en el uso normal se guarden, se sustituyan y se
> olviden las cosas correctas. Eso se mide de principio a fin, con asistentes reales y con los caminos reales de guardado y aprobación, en
> [LIFECYCLE-EVAL.md](LIFECYCLE-EVAL.md).

## Qué se mide

**Solo la recuperación.** Cada turno de una conversación se guarda como un dato en una memoria nueva y vacía ("Caroline on 8 May,
2023: …", las fotos como sus pies de foto). Después cada pregunta se hace a través de la propia recuperación de BrainAI, con los
ajustes por defecto del servidor y sus modelos locales, para hasta 10 resultados. Una pregunta cuenta como encontrada en el puesto *n* cuando el resultado
*n* es uno de los turnos que LoCoMo marca como su evidencia.

Ningún modelo de lenguaje escribe ni juzga una respuesta. Por eso estas cifras **no son comparables** con las puntuaciones de LoCoMo
de principio a fin que publican los productos de memoria, donde un modelo responde a partir de lo recuperado y otro modelo lo califica.
Dicen con qué frecuencia la parte correcta de la conversación llega al asistente, que es la parte de la que
se encarga BrainAI.

Se dejan fuera las 446 preguntas adversarias (categoría 5, que no tienen respuesta en la conversación) y 4 preguntas
sin evidencia. Una pregunta de varios saltos cuenta como encontrada cuando se devuelve cualquiera de sus turnos de evidencia.

**Evidencia corregida.** Una auditoría independiente de las respuestas correctas de LoCoMo
([dial481/locomo-audit](https://github.com/dial481/locomo-audit), CC BY-NC 4.0) encontró 156 errores, 57 de ellos
preguntas cuya evidencia apunta al turno equivocado. Como esta prueba puntúa justamente esa evidencia, esas 57
preguntas usan por defecto los turnos corregidos de la auditoría. Los otros 99 errores afectan a la respuesta, no a dónde está, y
aquí no cambian nada. `--evidence original` puntúa con la evidencia propia de LoCoMo.

## Resultados

8 de noviembre de 2026, BrainAI 1.0.1 con el reordenador (B3, sin publicar): modelo de búsqueda Xenova/multilingual-e5-small (q8),
reordenador cross-encoder/mmarco-mMiniLMv2-L12-H384-v1 (int8), datos de LoCoMo en el commit cbfbc1d. 5.882 turnos guardados; 1.536
preguntas puntuadas; 195 segundos en un Mac con Apple Silicon.

La búsqueda de la recuperación encuentra sus 20 primeras coincidencias por significado y por palabras; después el reordenador, un modelo local pequeño, lee la
pregunta junto a cada una de ellas y las pone en su propio orden.

| Preguntas | Cuántas | Encontrada la primera | En las 5 primeras | En las 8 primeras (por defecto) | En las 10 primeras | MRR |
|---|---:|---:|---:|---:|---:|---:|
| De un salto | 841 | 56,2% | 73,8% | 75,9% | 77,1% | 0,638 |
| De varios saltos | 282 | 41,1% | 66,7% | 69,9% | 70,2% | 0,527 |
| Temporales | 321 | 56,4% | 74,5% | 76,9% | 77,6% | 0,643 |
| De dominio abierto | 92 | 15,2% | 32,6% | 35,9% | 41,3% | 0,236 |
| **Todas** | **1.536** | **51,0%** | **70,2%** | **72,6%** | **73,8%** | **0,595** |

MRR (rango recíproco medio) es 1 cuando la respuesta sale siempre la primera, y 0,5 cuando sale la segunda de media; las dos tablas
cuentan respuestas hasta el resultado 20 (`--limit 20`).

El reordenador solo reordena las 20 primeras coincidencias, así que las 20 primeras (75,9%) son las mismas con o sin él; lo que cambia es
lo cerca de la cabeza que queda la respuesta. En la memoria del propio autor (unos 370 datos y 70 preguntas con respuesta conocida) el
dato correcto salió el primero en el 76% de las preguntas en lugar del 61%. Cuesta CPU en cada recuperación: en esa memoria una recuperación tarda
unos 0,3 s (mediana de sus 52 preguntas, 1,7 s de tiempo de CPU entre núcleos) en un mini PC Intel Core Ultra 7, con el
reordenador leyendo 20 datos reales. Hasta B5 tardaba 0,9 s y 18 s de CPU, porque los grupos de hilos de los dos modelos locales
se peleaban entre sí; ahora cada modelo usa como máximo 6 hilos que duermen mientras esperan. Una primera estimación de 65 ms,
hecha con 20 datos inventados y cortos, se quedó muy corta. Leer menos de cada dato sería más rápido (192 tokens: 0,21 s) pero
perdía respuestas en datos largos (LoCoMo con turnos agrupados en datos de 1.000 caracteres: 86,1% en las 8 primeras en lugar de 90,8%),
así que el reordenador lee hasta 256 tokens. Un reordenador más grande (bge-reranker-v2-m3) encontró la
respuesta la primera algo más a menudo (59% en LoCoMo) pero tardaba varios segundos por búsqueda, demasiado lento para ser el predeterminado.
`RERANK=off` lo desactiva.

### Apodos y otras formas de decirlo (B4)

Puntuada con la evidencia corregida de la auditoría (véase arriba), la búsqueda actual encuentra la respuesta la primera en el 51,7% de
las 1.536 preguntas, en las 8 primeras en el 73,8% y en las 20 primeras en el 76,9% (MRR 0,603), lo mismo que antes con una diferencia de unas pocas
preguntas. LoCoMo no puede mostrar las dos novedades de B4: sus preguntas están en inglés y no nombran proyectos. Se
midieron en cambio en la memoria del propio autor (52 preguntas, y otras 20 apartadas que nunca se usaron para ajustar):

| | Encontrada la primera | En las 3 primeras | En las 8 primeras |
|---|---:|---:|---:|
| Antes de B4 | 77% | 90% | 96% |
| Con apodos y otras formas de decirlo | 83% | 94% | 98% |
| Preguntas apartadas, antes → después | 80% → 75% | 90% → 95% | 100% → 100% |

En las 52 preguntas se movieron seis, y todas a mejor: preguntas en español sobre datos escritos en inglés, y
preguntas que llaman a un proyecto por su nombre de andar por casa. De las 20 apartadas, una subió (del sexto al segundo puesto) y una bajó
(del primero al segundo). Cada forma de decirlo adicional es una pasada más del reordenador, y una recuperación usa como máximo dos (la forma con
el nombre real de un apodo cuenta como una), así que una recuperación con dos tarda hasta el triple; en las preguntas del autor,
que incluyen algunas, la décima parte más lenta tardó unos 0,6 s. Se midieron otras dos ideas y se
descartaron: vectores adicionales para las partes de los datos largos (sin ganancia en estas preguntas ni en LoCoMo con turnos agrupados en datos de
1.000 caracteres, `--pack 1000`) y una cabecera corta antes de cada dato para el reordenador (ganancia en un conjunto, pérdida
en el otro).

### Cuando nada coincide de cerca (B6)

La mejor puntuación del reordenador también indica cuándo nada coincide de cerca, pero no con la fiabilidad suficiente para ocultar resultados: algunas de las
preguntas reales del autor puntuaron menos que otras sin relación (la real más baja −5,4, la sin relación más alta −0,6). Por eso la recuperación siempre
devuelve sus datos más cercanos, y cuando la mejor puntuación del reordenador está por debajo de −4 la respuesta avisa de que ninguno coincide de cerca con la
pregunta. Medido sobre la propia puntuación, eso ocurre en 3 de 72 preguntas reales y en 23 de 32 sin relación; una pregunta
respondida por el estado fijado de su proyecto nunca recibe el aviso, y con `RERANK=off` no hay ninguno.

Saltarse el reordenador cuando la primera coincidencia de la búsqueda gana claramente se midió y se descartó: hecho con seguridad (solo cuando la
primera coincidencia supera a todas las demás del grupo por 0,03 o más en similitud) ahorraba cerca del 5% del trabajo del reordenador en
LoCoMo y entre el 1% y el 6% en las preguntas del autor.

### Preguntas sobre cómo va algo (B7)

Una pregunta sobre cómo va un proyecto recibe arriba la hoja de ruta y el estado más reciente de ese proyecto: el reordenador no sabe leer las
líneas de la hoja de ruta ("Done / Now / Next") y las enterraría. Desde B7, con el reordenador activado, eso solo ocurre cuando la
pregunta es sobre el proyecto entero ("how is X going?", "what's the next step for X?", "¿qué queda por hacer en X?").
Cuando nombra una parte ("what's the latest on X's episode strip?"), la hoja de ruta y el estado compiten con los demás datos
y el que trata de esa parte suele salir el primero. La prueba de recuperación del autor tiene tres conjuntos: 52 preguntas principales, 20 apartadas
y 100 redactadas a partir de los datos del autor en noviembre de 2026 (también apartadas). En las 100 el dato correcto salió el primero
en el 89% de las preguntas en lugar del 86%; las 52 y las 20 no cambiaron.

### Palabras de búsqueda y 12 resultados (B9)

Desde B9 un asistente que guarda puede añadir `keys` a un dato: hasta 15 palabras de búsqueda que el texto no dice (otros nombres, el
otro idioma, la fecha de un suceso). Se incrustan con el dato y se meten en el índice de palabras clave, y nunca se muestran. La
ganancia depende de que los asistentes las escriban, así que se simuló, no se midió en uso real: en 742 preguntas de LoCoMo con un
asistente simulado que guarda, las claves solo en el índice de palabras clave subieron las 8 primeras del 73,5% al 76,0%, y el dato y las claves
incrustados como un solo texto las subieron al 76,8% (ambos con el e5-small de hoy; con un modelo de incrustación mejor el segundo llegó al 87,7% desde el
84,4%). Los detalles están en el informe de investigación "Recall precision beyond B4" (§3.6). No se midieron las dos cosas juntas.

Ahora los asistentes reciben hasta 12 datos por recuperación en lugar de 8, dentro de unos 8.000 caracteres. En LoCoMo la evidencia estaba en
las 8 primeras para el 73,4% de las preguntas, en las 10 primeras para el 74,6% y en las 20 primeras para el 76,6%, así que 12 añade uno o dos puntos; el
panel no cambia.

### Preguntas sobre el tiempo (B10)

Desde B10, la recuperación lee las palabras de tiempo de una pregunta ("last week", "in July 2023", "hace 3 días", "recently") como un intervalo de
días. Los datos guardados o fechados en ese intervalo (cuenta una fecha como "2026-11-03" escrita en el dato) que la búsqueda
habría encontrado de todos modos reciben una lista ordenada más en la fusión: un impulso, no un filtro. Un intervalo que contiene más de la mitad de
los datos no añade nada, las búsquedas propias del panel no leen palabras de tiempo, y un asistente puede pasar fechas exactas `since`/`until`
para acotar la búsqueda. 244 de las 1.986 preguntas de LoCoMo contienen palabras de tiempo.

Tal como se ejecuta normalmente la prueba, cada turno se guarda el día de la ejecución, así que ninguna palabra de tiempo puede señalar una sesión.
`--dated` guarda cada turno el día de su sesión y hace las preguntas el día después de la última sesión. 20 primeras, reordenador
activado, evidencia auditada, ejecutado el 2026-11-11:

| Las 1.536 preguntas | @1 | @5 | @8 | @10 | @20 | MRR |
|---|---:|---:|---:|---:|---:|---:|
| Sin fechas (como antes de B10) | 51,9 | 70,9 | 73,5 | 74,7 | 76,6 | 0,604 |
| Con fechas | 52,7 | 71,7 | 74,3 | 75,5 | 77,6 | 0,611 |

Por pares: 15 preguntas ganadas y 3 perdidas dentro del primer resultado (neto +12), 16 ganadas y 4 perdidas dentro de 8 (neto +12). Solo se pueden mover
las preguntas con palabras de tiempo; la ejecución sin fechas coincide exactamente con la ejecución anterior a B10. En la prueba de recuperación del propio autor
(170 preguntas, casi ninguna sobre un momento) no cambió nada. El reordenador lee solo el
texto, así que el impulso decide sobre todo qué datos le llegan: con el reordenador activado, la ganancia es pequeña.

### EmbeddingGemma como modelo de búsqueda

Desde el cambio a EmbeddingGemma-300m (ONNX de 4 bits, 768 dimensiones; `EMBED_MODEL=e5` conserva el modelo antiguo), cada
umbral tiene un valor ajustado para él (`src/memory/embeddingProfile.ts`, calibrado con `src/scripts/calibrateEmbedder.ts`):
un mínimo de recuperación de 0,3 sin ventana, con el peso de los puestos de palabras clave en 0 (solo el significado ordena los candidatos; las coincidencias
solo por palabras clave siguen llegando al reordenador), y el orden de la búsqueda mezclado con el del reordenador (rerankPrior 1). 20 primeras, reordenador
activado, evidencia auditada, ejecutado el 2026-11-11:

| Las 1.536 preguntas | @1 | @5 | @8 | @10 | @20 | MRR |
|---|---:|---:|---:|---:|---:|---:|
| e5-small (antes) | 51,9 | 70,9 | 73,5 | 74,7 | 76,6 | 0,604 |
| EmbeddingGemma | 57,0 | 81,6 | 86,6 | 88,3 | 91,7 | 0,678 |

Por pares: 124 preguntas ganadas y 46 perdidas dentro del primer resultado (neto +78), 226 ganadas y 25 perdidas dentro de 8 (neto +201).
Ahora la búsqueda encuentra el turno correcto entre sus 20 primeros en el 92% de las preguntas, así que el reordenador lo tiene para trabajar con él mucho
más a menudo. En la prueba de recuperación del propio autor (168 preguntas, en el mini PC que la sirve, la misma copia de seguridad para
ambos): encontrada la primera 149 en lugar de 143, en las 3 primeras 162 en lugar de 160, en las 8 primeras 165 en lugar de 166 (el único dato
que salió de las 8 primeras está dentro de los 12 resultados que recibe un asistente). Solo las 20 preguntas apartadas: primera 16 en lugar de
15, 8 primeras 19 de 19 en ambos casos. Advertencia: el peso de las palabras clave y el rango previo se eligieron con los tres archivos de preguntas, incluidas
las apartadas, así que no son una comprobación intacta. En un Mac los mismos ajustes dieron 150 / 162 / 166 (los núcleos de ONNX
difieren un poco entre ARM y x86).

Antes de elegir se probaron modelos remotos en la misma prueba (OpenRouter, 2026-11-11): OpenAI text-embedding-3-small
llegó al 87,2% a 20, Gemini embedding al 87,1%, bge-m3 al 83,1%, Qwen3-Embedding-8B al 80,7%; todos por debajo del modelo local. Un
reordenador de pago (Voyage rerank-2.5) sobre EmbeddingGemma llegó al 72,3% de primeras en LoCoMo pero no cambió nada en las preguntas
del propio autor, así que no se adoptó.

### Sin el reordenador

Los mismos datos, solo con la búsqueda de BrainAI 1.0.1 (`npm run bench:locomo -- --limit 20 --rerank off`); 31 segundos.

| Preguntas | Cuántas | Encontrada la primera | En las 5 primeras | En las 10 primeras | MRR |
|---|---:|---:|---:|---:|---:|
| De un salto | 841 | 35,7% | 60,4% | 69,7% | 0,469 |
| De varios saltos | 282 | 23,0% | 51,1% | 61,7% | 0,354 |
| Temporales | 321 | 43,9% | 67,9% | 74,1% | 0,546 |
| De dominio abierto | 92 | 16,3% | 29,3% | 40,2% | 0,229 |
| **Todas** | **1.536** | **33,9%** | **58,4%** | **67,4%** | **0,450** |

La recuperación de un asistente devuelve 8 resultados a menos que pida más, y 20 como máximo. La misma ejecución, puntuada en cada uno:

| Preguntas | En las 8 primeras (por defecto) | En las 10 primeras | En las 20 primeras (máximo) |
|---|---:|---:|---:|
| De un salto | 66,0% | 69,7% | 78,8% |
| De varios saltos | 58,9% | 61,7% | 73,4% |
| Temporales | 71,3% | 74,1% | 78,8% |
| De dominio abierto | 37,0% | 40,2% | 46,7% |
| **Todas** | **64,1%** | **67,4%** | **75,9%** |

Sin el reordenador, pedir 20 encontró la respuesta en unas 12 preguntas más de cada 100 que las 8 por defecto; con él,
las 8 por defecto ya encuentran el 72,6%.

Qué significa esto en el uso: en unas tres de cada cuatro preguntas, un asistente que recupera sus 8 datos por defecto obtiene al
menos un turno que la responde (en una pregunta de varios saltos, al menos uno de los turnos que necesita), y en la mitad de ellas
la respuesta es el primer dato. Las preguntas de dominio abierto, que necesitan conocimiento de fuera de la conversación, son las más difíciles,
como era de esperar.

## LongMemEval

Una segunda prueba pública, [LongMemEval](https://github.com/xiaowu0162/LongMemEval) (Wu et al., "LongMemEval: Benchmarking Chat
Assistants on Long-Term Interactive Memory", ICLR 2025). Cada una de sus 500 preguntas viene con su propio historial de chat de
unas 50 sesiones (115.000 tokens, 550 turnos de media) entre un usuario y un asistente, con sesiones de distracción
mezcladas, y de una a unas pocas sesiones que contienen la respuesta.

**Licencia y origen.** El código y los datos tienen licencia MIT (LICENSE del repositorio, "Copyright (c) 2024 Di Wu"; la
ficha del conjunto de datos de Hugging Face dice `license: mit`), así que usarlos para esta prueba está permitido. Datos:
[xiaowu0162/longmemeval-cleaned](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned) en la revisión
98d7416c24c778c2fee6e6f3006e7a073259d48f, archivo `longmemeval_s_cleaned.json` (277 MB, SHA-256
d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442), la limpieza de septiembre de 2025 de los archivos
originales de los autores. Se descarga en `bench-results/cache/` (ignorada por git) y se comprueba contra ese hash; nunca se sube al repositorio.

### Qué se mide

Solo la recuperación, como en LoCoMo, con las mismas reglas: ningún modelo escribe ni juzga una respuesta, las ejecuciones son por pares (los mismos
datos y preguntas con el reordenador activado y desactivado) y se publican los fallos.

- **Variante: LongMemEval_S** (unas 50 sesiones por pregunta), no la variante oráculo (solo las sesiones con la respuesta, lo que
  hace trivial la recuperación) ni la M (unas 500 sesiones).
- **Unidad: un dato por turno**, como los turnos de LoCoMo: "User on 2023/05/20 (Sat) 02:21: ..." o "Assistant on ...", guardado
  por el propietario en una memoria nueva en memoria para cada pregunta, y luego consultado a través del mismo `MemoryService.recall` que usa el
  servidor, con sus modelos por defecto (EmbeddingGemma de 4 bits, reordenador mMiniLM int8), para hasta 20 resultados. Un turno más largo
  que el límite de 1.000 caracteres de un dato (unos 4 de cada 10 turnos) se corta en finales de párrafo, línea, frase o palabra en varios
  datos que empiezan todos con el mismo interlocutor y la misma fecha. No agrupé turnos en datos más largos: los turnos de LongMemEval
  ya tienen 880 caracteres de media, así que agrupar contendría dos turnos como mucho, y un dato por turno mantiene exactas las
  etiquetas a nivel de turno.
- **Dos puntuaciones.** *Sesión* (s): una sesión con la respuesta (`answer_session_ids`) está entre los *k* primeros resultados, que es el
  nivel al que el propio LongMemEval informa de la recuperación. *Turno* (t): un turno etiquetado `has_answer` está entre los *k* primeros. Como
  una sesión tiene unos 10 turnos, la puntuación de sesión es mucho más fácil; el nivel de turno muestra si la recuperación encuentra la frase
  y no solo la conversación correcta. En las preguntas que necesitan varias sesiones, "all" exige que todas las sesiones con la respuesta
  estén entre los resultados (una pregunta de varias sesiones cuenta como encontrada en "s" cuando lo está cualquiera de ellas).
- **Abstención** (30 preguntas, ids que terminan en `_abs`, lo que se pregunta nunca se dijo) es una fila aparte. No hay nada
  que encontrar, así que lo que importa es con qué frecuencia la recuperación lo dice: la proporción de preguntas en las que se mostraría el aviso de coincidencia débil de la
  recuperación (el propio umbral del servidor, WEAK_SCORE), o la recuperación no devolvió nada. Sus puntuaciones de sesión y de turno
  se dan para que esté completo (la sesión etiquetada es una que habla de algo cercano).
- El reloj de la memoria no está ajustado (la fecha va en el texto de cada dato). `--dated`, que guarda cada turno el día de su sesión
  y pregunta en la fecha de la pregunta, dio aquí números idénticos.

### Coste y muestra

Unos 200.000 turnos distintos en los 500 historiales, y EmbeddingGemma en este Mac incrusta unos 17 datos por segundo, así que
una ejecución completa lleva unas 8 horas (medido: 46 segundos por pregunta, 6.514 s para 140), muy por encima de las 2 horas que me permití. Los
resultados de abajo son por tanto una **muestra estratificada: 20 preguntas de cada una de las 7 categorías (140)**, tomadas a intervalos
regulares a lo largo del archivo (no al azar, no elegidas por resultado), con 121.062 datos guardados. Las incrustaciones se guardan en caché por modelo en
`bench-results/cache/`, así que repetir con el reordenador desactivado o activado, con otro límite o con `--dated` lleva de 1 a 2 minutos.
Con 20 preguntas por fila un porcentaje se mueve 5 puntos por pregunta: toma las diferencias de unos pocos puntos como ruido.

### Resultados

18 de noviembre de 2026, BrainAI 1.4.0 (commit c9969b4, con los archivos de A3 añadidos), EmbeddingGemma-300m (4 bits), reordenador
cross-encoder/mmarco-mMiniLMv2-L12-H384-v1 (int8), LongMemEval_S limpio, 20 preguntas por categoría, hasta 20 resultados, en
un Mac con Apple Silicon. Sesión: una sesión con la respuesta entre las *k* primeras; Turno: un turno con la respuesta entre los *k* primeros.

| Categoría (20 cada una) | Sesión @1 | Sesión @8 | Sesión @20 | Turno @1 | Turno @8 | Turno @20 | Aviso de coincidencia débil |
|---|---:|---:|---:|---:|---:|---:|---:|
| Una sesión, usuario | 100% | 100% | 100% | 75% | 95% | 100% | 0% |
| Una sesión, asistente | 100% | 100% | 100% | 75% | 100% | 100% | 5% |
| Una sesión, preferencia | 75% | 100% | 100% | 15% | 70% | 95% | 25% |
| Varias sesiones | 100% | 100% | 100% | 50% | 95% | 100% | 35% |
| Actualización de conocimiento | 100% | 100% | 100% | 55% | 85% | 100% | 0% |
| Razonamiento temporal | 95% | 100% | 100% | 55% | 85% | 90% | 30% |
| Abstención | 95% | 100% | 100% | 10% | 20% | 20% | **55%** |
| **Las 140** | **95,0%** | **100%** | **100%** | **47,9%** | **78,6%** | **86,4%** | 21,4% |

La recuperación nunca devolvió nada (0% vacías en todas las categorías): su búsqueda siempre tiene datos cercanos que mostrar. En las seis
categorías reales el aviso de coincidencia débil es una falsa alarma, ya que hay una respuesta: el 16% de esas 120 preguntas (19 de ellas) (del 0% al
35% según la categoría). En la abstención es la señal correcta, y saltó en 11 de 20 (55%); las otras 9 devolvieron datos plausibles
sin aviso, que es el punto débil de "sin respuesta".

Preguntas que necesitan todas las sesiones con la respuesta (varias sesiones, temporales, las sesiones etiquetadas de la abstención): todas dentro de 8
resultados en el 75%, el 80% y el 80% de las preguntas (dentro de 20: 100%, 85%, 90%); en conjunto el 90,7% dentro de 8 y el 96,4% dentro de 20.

Sin el reordenador (solo la búsqueda, los mismos datos): sesión 95,0 / 99,3 / 100 y turno 34,3 / 77,1 / 86,4 (en 1 / 8 /
20), MRR 0,965 en ambos casos. La ganancia del reordenador está a nivel de turno en el puesto 1: 47,9% en lugar de 34,3% (varias sesiones
50% en lugar de 15%, actualización de conocimiento 55% en lugar de 30%); dentro de 20 no cambia nada, como en LoCoMo. El aviso necesita
la puntuación del reordenador, así que nunca se muestra sin él.

Lo más débil: reconocer las preguntas sin respuesta (abstención, 55% avisadas; su 20% a nivel de turno no es significativo, ya que no
tiene turno con la respuesta). Entre las categorías reales las más débiles son **una sesión, preferencia** (turno @1 15%, @8 70%: la respuesta es una preferencia
repartida en una respuesta larga, así que el turno etiquetado a menudo no es el que coincide con las palabras de la pregunta; sesión en el puesto 1
en el 75%, y el turno etiquetado de una pregunta no estaba entre los 20 primeros) y **razonamiento temporal** (la evidencia de 3 de 20
preguntas abarca sesiones que no se encuentran todas dentro de 20; a nivel de turno 90% en 20). Los 34 datos de 121.062 que no
se guardaron fueron rechazados por las comprobaciones de guardado (no se investigó).

Los fallos, por pregunta, están en `bench-results/longmemeval-2026-11-18-sample20.json` (puesto de la primera sesión con la respuesta,
del primer turno con la respuesta y de todas las sesiones con la respuesta para cada una de las 140 preguntas). Esos archivos los ignora git, como los de LoCoMo.

**Comparación.** El artículo de LongMemEval informa de la recuperación a nivel de sesión sobre las 500 preguntas para recuperadores como
BM25, Contriever, Stella y GTE. No copié esas cifras aquí: no las he vuelto a comprobar con las tablas del artículo, y miden otras cosas (las 500 preguntas, indexación por sesión o por valor de turno con otros tamaños de unidad,
recuperación de cualquier sesión con la respuesta entre las *k* primeras sesiones en lugar de entre *k* datos). Las cifras de sesión de arriba están
cerca del techo y, con una muestra de 20 preguntas, no pueden separar unos recuperadores de otros; el nivel de turno y la tasa de coincidencia débil son
donde BrainAI puede mejorar.

```bash
npm run bench:longmemeval -- --sample 20              # 20 questions per category, up to 20 results
npm run bench:longmemeval -- --sample 20 --rerank off  # the search alone (1 minute once embeddings are cached)
npm run bench:longmemeval                              # all 500 questions: about 8 hours here
npm run bench:longmemeval -- --only <question_id,...>  # named questions;  --dated  --limit <n>  --cache/--out <dir>
```

## Cómo ejecutarlo

```bash
npm run bench:locomo                 # up to 10 results
npm run bench:locomo -- --limit 20    # up to 20
npm run bench:locomo -- --rerank off  # the search alone
npm run bench:locomo -- --evidence original              # LoCoMo's own evidence, without the audit's corrections
npm run bench:locomo -- --against bench-results/<earlier>.json   # questions gained and lost since that run
```

La primera ejecución descarga `locomo10.json` (2,8 MB) y el `errors.json` de la auditoría (150 KB) desde sus commits fijados
en `bench-results/cache/` y comprueba sus SHA-256; un archivo que no coincide se rechaza, nunca se puntúa. Los resultados
se imprimen como tabla y se escriben en `bench-results/locomo-<date>-top<limit>.json` (con `-norerank` añadido sin el
reordenador, y `-original` con la evidencia propia de LoCoMo), con los modelos y ajustes usados y el puesto de cada pregunta, de modo que dos
ejecuciones se puedan comparar pregunta a pregunta. Nada de LoCoMo ni de la auditoría se conserva en el repositorio.
