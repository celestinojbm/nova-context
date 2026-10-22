import { EmailForm } from "@/components/email-form";
import { CaptureSlot } from "@/components/figures/capture/slot";
import { LockSlot } from "@/components/figures/lock/slot";

export default function HomePage() {
  return (
    <>
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-5xl flex-wrap items-baseline justify-between gap-x-6 gap-y-2 px-5 py-3.5">
          <a href="#inicio" className="text-sm font-semibold tracking-tight text-foreground">
            Nova Context
          </a>
          <nav className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
            <a href="#como-funciona" className="hover:text-foreground">
              Cómo funciona
            </a>
            <a href="#modos" className="hover:text-foreground">
              Modos
            </a>
            <a href="#aprobacion" className="hover:text-foreground">
              Aprobación
            </a>
            <a href="#que-es" className="hover:text-foreground">
              Qué es
            </a>
          </nav>
        </div>
      </header>
      <main id="inicio" className="mx-auto flex max-w-5xl flex-col gap-20 px-5 py-16 md:py-24">
        <section className="flex flex-col gap-6">
          <p className="text-sm text-muted-foreground">Infraestructura de contexto humano</p>
          <h1 className="max-w-3xl text-4xl font-semibold tracking-tight text-balance md:text-5xl">
            Lo que ves, dicho con tus palabras, queda donde pertenece.
          </h1>
          <p className="max-w-2xl text-lg text-muted-foreground">
            Nova Context no es un chat ni un cuaderno. Es la capa debajo de los asistentes: capturas lo que estás viendo, dices qué
            significa para ti y qué quieres hacer con ello, y eso queda como un momento tuyo. Lo ves antes de que se guarde, y nada
            sale hacia fuera si tú no lo confirmas.
          </p>
          <EmailForm />
        </section>

        <section id="como-funciona" className="flex flex-col gap-6">
          <h2 className="text-2xl font-semibold tracking-tight">Un gesto, y el momento todavía no está guardado</h2>
          <p className="max-w-2xl text-muted-foreground">
            Nova permanece invisible hasta que lo invocas. Te enseña lo que ve antes de almacenar nada. Tú hablas, y tus palabras se
            conservan tal cual: la interpretación se puede corregir, lo que dijiste no se reescribe. Nada entra en un proyecto hasta
            que confirmas. Si descartas, el gesto se borra por completo.
          </p>
          <CaptureSlot />
          <div className="grid gap-8 md:grid-cols-3">
            <article className="flex flex-col gap-2">
              <h3 className="font-medium">Ver</h3>
              <p className="text-sm text-muted-foreground">
                El cristal del banco. Lo que hay en pantalla, a la vista, antes de que exista un recuerdo.
              </p>
            </article>
            <article className="flex flex-col gap-2">
              <h3 className="font-medium">Decir</h3>
              <p className="text-sm text-muted-foreground">
                El émbolo. La intención la dices tú. Nova puede proponerte un vínculo; no supone para qué lo quieres.
              </p>
            </article>
            <article className="flex flex-col gap-2">
              <h3 className="font-medium">Confirmar</h3>
              <p className="text-sm text-muted-foreground">
                El perno y el sello. Sin ese gesto la ficha no entra en la bandeja del proyecto.
              </p>
            </article>
          </div>
        </section>

        <section id="modos" className="flex max-w-2xl flex-col gap-4">
          <h2 className="text-2xl font-semibold tracking-tight">Dos modos, y ninguno a escondidas</h2>
          <p className="text-muted-foreground">
            En la captura instantánea invocas, miras lo que Nova ha tomado, dices la frase y confirmas. Sigues en lo que estabas
            haciendo.
          </p>
          <p className="text-muted-foreground">
            En el contexto en vivo empiezas una sesión, el indicador permanece a la vista y la terminas tú. Puedes preguntar sobre lo
            que está pasando y guardar solo los tramos que pides.
          </p>
          <p className="text-muted-foreground">
            No hay un tercer modo encubierto ni grabación continua. El margen breve que permite alcanzar lo que acaba de ocurrir es
            opcional, local y señalado: en la figura es el vial, que no viaja por el cable.
          </p>
        </section>

        <section id="aprobacion" className="flex flex-col gap-6">
          <h2 className="text-2xl font-semibold tracking-tight">Nada sale sin tu llave</h2>
          <p className="max-w-2xl text-muted-foreground">
            Dentro de Nova, ordenar un momento o preparar algo reversible puede seguir su curso. En cuanto algo va a salir — una
            página, un mensaje, un encargo hacia otra herramienta — ves el contenido y decides. La caja es esa regla: el cajón
            enseña el momento; la salida permanece cerrada hasta que metes la llave.
          </p>
          <LockSlot />
        </section>

        <section id="que-es" className="flex max-w-2xl flex-col gap-4">
          <h2 className="text-2xl font-semibold tracking-tight">Infraestructura, no otro asistente</h2>
          <p className="text-muted-foreground">
            Nova es el sustrato que captura, recuerda y propone acciones, y que un asistente puede usar con tu permiso. La aplicación
            es un cliente de referencia. La memoria es tuya: puedes exportarla y puedes borrarla. Tu contexto no es el negocio.
          </p>
          <p className="text-muted-foreground">
            No compite por ser el modelo que conversa contigo, no toma notas en silencio y no observa la pantalla si no lo has
            invocado. La persona sigue siendo la autoridad sobre lo que se guarda y sobre lo que sale.
          </p>
        </section>

        <section className="flex max-w-2xl flex-col gap-4 border-t border-border pt-10">
          <h2 className="text-2xl font-semibold tracking-tight">Escríbenos</h2>
          <p className="text-muted-foreground">Si quieres hablar del producto, deja tu correo. Es el único gesto que pedimos desde aquí.</p>
          <EmailForm />
        </section>
      </main>
      <footer className="border-t border-border">
        <div className="mx-auto max-w-5xl px-5 py-6 text-sm text-muted-foreground">Nova Context</div>
      </footer>
    </>
  );
}
