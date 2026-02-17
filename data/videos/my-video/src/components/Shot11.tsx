import {
	AbsoluteFill,
	interpolate,
	useCurrentFrame,
	useVideoConfig,
	Img,
	staticFile,
	Audio,
	Easing,
} from 'remotion';
import React from 'react';

export const Shot11: React.FC = () => {
	const frame = useCurrentFrame();
	const {fps, durationInFrames} = useVideoConfig();

	// 0-12s range scaled to 6.7s
	// Camera flight: Zoom in and slight tilt/y-movement
	const progress = interpolate(frame, [0, durationInFrames], [0, 1], {
		easing: Easing.out(Easing.quad),
	});

	const scale = interpolate(progress, [0, 1], [1, 1.2]);
	const translateY = interpolate(progress, [0, 1], [0, -50]);

	// Road Signs appearance
	const signsOpacity = interpolate(frame, [durationInFrames - 2 * fps, durationInFrames - 0.5 * fps], [0, 1], {
		extrapolateLeft: 'clamp',
		extrapolateRight: 'clamp',
	});

	return (
		<AbsoluteFill style={{backgroundColor: '#0a0f0a'}}>
			{/* Background Image with Movement */}
			<AbsoluteFill
				style={{
					transform: `scale(${scale}) translateY(${translateY}px)`,
				}}
			>
				<Img
					src={staticFile('two_roads.png')}
					style={{
						width: '100%',
						height: '100%',
						objectFit: 'cover',
					}}
				/>
			</AbsoluteFill>

			{/* Cinematic Color Grading Overlays */}
			<AbsoluteFill
				style={{
					background: 'linear-gradient(to bottom, rgba(0, 20, 40, 0.3), transparent, rgba(20, 10, 0, 0.2))',
					mixBlendMode: 'multiply',
				}}
			/>
			<AbsoluteFill
				style={{
					backgroundColor: 'rgba(0, 255, 200, 0.05)',
					mixBlendMode: 'overlay',
				}}
			/>

			{/* Road Signs */}
			<AbsoluteFill
				style={{
					opacity: signsOpacity,
					fontFamily: 'Inter, sans-serif',
				}}
			>
				{/* ЗАГС Sign (Smooth Road - Leftish) */}
				<div
					className="absolute"
					style={{
						left: '30%',
						top: '40%',
						transform: 'translate(-50%, -50%) rotate(-5deg)',
					}}
				>
					<div className="bg-white/90 px-6 py-2 border-2 border-blue-900 rounded shadow-lg">
						<span className="text-blue-900 text-4xl font-black uppercase tracking-widest">ЗАГС</span>
					</div>
					<div className="w-1 h-20 bg-gray-800 mx-auto" />
				</div>

				{/* Суд Sign (Rocky Road - Rightish) */}
				<div
					className="absolute"
					style={{
						right: '30%',
						top: '45%',
						transform: 'translate(50%, -50%) rotate(5deg)',
					}}
				>
					<div className="bg-gray-200/90 px-6 py-2 border-2 border-red-900 rounded shadow-lg">
						<span className="text-red-900 text-4xl font-black uppercase tracking-widest">Суд</span>
					</div>
					<div className="w-1 h-24 bg-gray-900 mx-auto" />
				</div>
			</AbsoluteFill>

			{/* Mist/Fog Overlay */}
			<AbsoluteFill
				style={{
					background: 'linear-gradient(to top, rgba(255,255,255,0.1), transparent 50%)',
					opacity: 0.5,
					pointerEvents: 'none',
				}}
			/>

			<Audio src={staticFile('shot11_voice.mp3')} />
		</AbsoluteFill>
	);
};
