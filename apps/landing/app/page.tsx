import { LogoLockup, Symbol } from "@/components/brand/mark";
import { EmailForm } from "@/components/email-form";
import { CaptureSlot } from "@/components/figures/capture/slot";
import { LockSlot } from "@/components/figures/lock/slot";

export default function HomePage() {
  return (
    <>
      <header className="sticky top-0 z-20 border-b border-white/10 bg-black/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-10 gap-y-3 px-5 py-4 md:min-h-[76px] md:px-16">
          <a href="#inicio" aria-label="nova context" className="text-white">
            <LogoLockup />
          </a>
          <nav className="flex max-w-full flex-wrap gap-x-8 gap-y-2 text-lg text-[#A1A1A1]">
            <a href="#como-funciona" className="hover:text-[#EDEDED]">
              Cómo funciona
            </a>
            <a href="#modos" className="hover:text-[#EDEDED]">
              Modos
            </a>
            <a href="#aprobacion" className="hover:text-[#EDEDED]">
              Aprobación
            </a>
            <a href="#que-es" className="hover:text-[#EDEDED]">
              Qué es
            </a>
          </nav>
        </div>
      </header>

      <section id="inicio" className="hero">
        <div className="hero-grid" aria-hidden="true" />
        <svg className="hero-grain" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <filter id="grain">
            <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="3" stitchTiles="stitch" />
            <feColorMatrix values="0 0 0 0 .5  0 0 0 0 .5  0 0 0 0 .5  0 0 0 1 0" />
          </filter>
          <rect width="100%" height="100%" filter="url(#grain)" />
        </svg>

        <div className="hero-top">
          <p className="font-mono text-base tracking-[0.08em] text-[#A1A1A1] uppercase md:text-lg">Infraestructura de contexto humano</p>
          <h1 className="hero-title mx-auto mt-5 w-full max-w-[1200px]">
            Lo que ves, dicho con tus palabras,
            <span className="mt-2 block text-[#8F8F8F]">queda donde pertenece.</span>
          </h1>
        </div>

        <div className="hero-stage">
          <div className="hero-halo" aria-hidden="true" />
          <div className="hero-star">
            <Symbol variant="hero" className="h-full w-full" />
          </div>
          <span className="hero-tag top-[16%] left-[8%] hidden lg:inline">percibes</span>
          <span className="hero-tag top-[22%] right-[8%] hidden lg:inline">significa</span>
          <span className="hero-tag top-[64%] left-[11%] hidden lg:inline">conecta con</span>
          <span className="hero-tag top-[70%] right-[9%] hidden lg:inline">quieres hacer</span>
        </div>

        <div className="hero-foot">
          <p className="max-w-3xl text-[1.125rem] leading-relaxed text-[#A1A1A1] md:text-[1.25rem]">
            Nova Context no es un chat ni un cuaderno. Es la capa debajo de los asistentes: capturas lo que estás viendo, dices qué
            significa para ti y qué quieres hacer con ello, y eso queda como un momento tuyo. Lo ves antes de que se guarde, y nada
            sale hacia fuera si tú no lo confirmas.
          </p>
          <EmailForm />
        </div>
      </section>

      <main className="mx-auto flex max-w-5xl flex-col gap-20 bg-black px-5 py-20">
        <section id="como-funciona" className="flex flex-col gap-6">
          <h2 className="section-title">Un gesto, y el momento todavía no está guardado</h2>
          <p className="max-w-2xl text-[#A1A1A1]">
            Nova permanece invisible hasta que lo invocas. Te enseña lo que ve antes de almacenar nada. Tú hablas, y tus palabras se
            conservan tal cual: la interpretación se puede corregir, lo que dijiste no se reescribe. Nada entra en un proyecto hasta
            que confirmas. Si descartas, el gesto se borra por completo.
          </p>
          <CaptureSlot />
          <div className="grid gap-8 md:grid-cols-3">
            <article className="flex flex-col gap-2">
              <h3 className="text-2xl leading-tight font-semibold">Ver</h3>
              <p className="text-[#A1A1A1]">El cristal del banco. Lo que hay en pantalla, a la vista, antes de que exista un recuerdo.</p>
            </article>
            <article className="flex flex-col gap-2">
              <h3 className="text-2xl leading-tight font-semibold">Decir</h3>
              <p className="text-[#A1A1A1]">El émbolo. La intención la dices tú. Nova puede proponerte un vínculo; no supone para qué lo quieres.</p>
            </article>
            <article className="flex flex-col gap-2">
              <h3 className="text-2xl leading-tight font-semibold">Confirmar</h3>
              <p className="text-[#A1A1A1]">El perno y el sello. Sin ese gesto la ficha no entra en la bandeja del proyecto.</p>
            </article>
          </div>
        </section>

        <section id="modos" className="flex max-w-2xl flex-col gap-4">
          <h2 className="section-title">Dos modos, y ninguno a escondidas</h2>
          <p className="text-[#A1A1A1]">
            En la captura instantánea invocas, miras lo que Nova ha tomado, dices la frase y confirmas. Sigues en lo que estabas
            haciendo.
          </p>
          <p className="text-[#A1A1A1]">
            En el contexto en vivo empiezas una sesión, el indicador permanece a la vista y la terminas tú. Puedes preguntar sobre lo
            que está pasando y guardar solo los tramos que pides.
          </p>
          <p className="text-[#A1A1A1]">
            No hay un tercer modo encubierto ni grabación continua. El margen breve que permite alcanzar lo que acaba de ocurrir es
            opcional, local y señalado: en la figura es el vial, que no viaja por el cable.
          </p>
        </section>

        <section id="aprobacion" className="flex flex-col gap-6">
          <h2 className="section-title">Nada sale sin tu llave</h2>
          <p className="max-w-2xl text-[#A1A1A1]">
            Dentro de Nova, ordenar un momento o preparar algo reversible puede seguir su curso. En cuanto algo va a salir — una
            página, un mensaje, un encargo hacia otra herramienta — ves el contenido y decides. La caja es esa regla: el cajón
            enseña el momento; la salida permanece cerrada hasta que metes la llave.
          </p>
          <LockSlot />
        </section>

        <section id="que-es" className="flex max-w-2xl flex-col gap-4">
          <h2 className="section-title">Infraestructura, no otro asistente</h2>
          <p className="text-[#A1A1A1]">
            Nova es el sustrato que captura, recuerda y propone acciones, y que un asistente puede usar con tu permiso. La aplicación
            es un cliente de referencia. La memoria es tuya: puedes exportarla y puedes borrarla. Tu contexto no es el negocio.
          </p>
          <p className="text-[#A1A1A1]">
            No compite por ser el modelo que conversa contigo, no toma notas en silencio y no observa la pantalla si no lo has
            invocado. La persona sigue siendo la autoridad sobre lo que se guarda y sobre lo que sale.
          </p>
        </section>

        <section className="flex max-w-2xl flex-col gap-4 border-t border-white/10 pt-10">
          <h2 className="section-title">Escríbenos</h2>
          <p className="text-[#A1A1A1]">Si quieres hablar del producto, deja tu correo. Es el único gesto que pedimos desde aquí.</p>
          <EmailForm />
        </section>
      </main>

      <footer className="border-t border-white/10">
        <div className="mx-auto max-w-6xl px-5 py-6 md:px-16">
          <LogoLockup />
        </div>
      </footer>
    </>
  );
}
